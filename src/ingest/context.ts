/**
 * Editorial context around the films: press coverage, reviews, a rating.
 *
 * This runs on its own slow beat. Occupancy is a number that changes minute to
 * minute and is lost forever if missed; an article published this morning will
 * still be there tonight. Refreshing it every five minutes alongside the
 * scrapers would spend the run's budget on the part that matters least.
 */

import { filmIdentity } from "@/core/match";
import { rateLimited } from "@/lib/http";
import { type CsfdFilm, fetchCinemaIndex, fetchRating as fetchCsfdRating } from "@/sources/csfd";
import { fetchArticles } from "@/sources/news";
import { fetchRating, hasTmdbKey } from "@/sources/tmdb";
import type { Film, Rating, State } from "@/store/types";

/** How stale a film's context may get before it is refreshed. */
const REFRESH_AFTER_HOURS = 6;

/** Films with almost no admissions are not worth a request. */
const MIN_ADMISSIONS = 50;

export type ContextResult = {
  refreshed: number;
  articles: number;
  ratings: number;
  /** Of those, how many came from ČSFD rather than the TMDB fallback. */
  csfdRatings: number;
  errors: string[];
};

/**
 * Match our films to ČSFD's cinema listing.
 *
 * ČSFD's search is disallowed in robots.txt, so a film is found by name in the
 * year's premiere listing instead. That listing uses the Czech distribution
 * title, which is the key `filmIdentity` already builds for exactly this — the
 * same one that joins Golden Apple and the UFD tables to the rest.
 */
export function indexCsfd(films: readonly CsfdFilm[]): Map<string, CsfdFilm> {
  const byKey = new Map<string, CsfdFilm>();
  for (const film of films) {
    const key = filmIdentity(film.title, null).matchKey;
    if (key && !byKey.has(key)) byKey.set(key, film);
  }
  return byKey;
}

export const csfdMatch = (index: Map<string, CsfdFilm>, film: Film): CsfdFilm | undefined =>
  index.get(filmIdentity(film.title, null).matchKey);

export async function refreshFilmContext(
  state: State,
  opts: { deadline: number; limit?: number },
): Promise<ContextResult> {
  const result: ContextResult = { refreshed: 0, articles: 0, ratings: 0, csfdRatings: 0, errors: [] };
  const now = Date.now();
  const staleBefore = now - REFRESH_AFTER_HOURS * 60 * 60 * 1000;

  // Rank by how much the film is actually playing, so a limited run spends its
  // requests on the titles anyone is looking at.
  const admissions = new Map<number, number>();
  for (const s of Object.values(state.screenings)) {
    admissions.set(s.filmId, (admissions.get(s.filmId) ?? 0) + (s.settled?.sold ?? s.sold ?? 0));
  }

  const due = state.films
    .filter((f) => (admissions.get(f.id) ?? 0) >= MIN_ADMISSIONS)
    .filter((f) => !f.contextAt || new Date(f.contextAt).getTime() < staleBefore)
    .sort((a, b) => (admissions.get(b.id) ?? 0) - (admissions.get(a.id) ?? 0))
    .slice(0, opts.limit ?? 12);

  // One listing fetch names every film ČSFD has in cinemas this year, so the
  // per-film cost is a single page rather than a search we are not allowed to
  // make anyway.
  let csfd = new Map<string, CsfdFilm>();
  if (due.length > 0) {
    try {
      csfd = indexCsfd(await fetchCinemaIndex());
    } catch (err) {
      result.errors.push(`csfd index: ${String(err)}`);
    }
  }

  await rateLimited(
    due,
    async (film) => {
      const articles = await fetchArticles(film.title);
      film.articles = articles;
      result.articles += articles.length;

      // ČSFD first: it is the rating Czech audiences actually quote, and the
      // one the operator agreed to read. TMDB covers what the cinema listing
      // does not — re-releases, films that premiered in an earlier year.
      const onCsfd = csfdMatch(csfd, film);
      let rating: Rating | null = onCsfd
        ? await fetchCsfdRating(onCsfd).then(
            (r): Rating | null =>
              r ? { percent: r.percent, votes: r.votes, source: "csfd", url: r.url, csfdId: r.csfdId } : null,
            (err) => {
              result.errors.push(`csfd ${film.title}: ${String(err)}`);
              return null;
            },
          )
        : null;
      if (rating) result.csfdRatings += 1;
      if (!rating && hasTmdbKey()) rating = await fetchRating(film.title, film.originalTitle);

      if (rating) {
        film.rating = rating;
        result.ratings += 1;
      }

      film.contextAt = new Date().toISOString();
      result.refreshed += 1;
    },
    {
      // Google News tolerates this easily; the pause is politeness, not a limit.
      minIntervalMs: 800,
      deadline: opts.deadline,
      onError: (film, err) => result.errors.push(`context ${film.title}: ${String(err)}`),
    },
  );

  return result;
}
