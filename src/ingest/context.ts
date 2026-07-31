/**
 * Editorial context around the films: press coverage, reviews, a rating.
 *
 * This runs on its own slow beat. Occupancy is a number that changes minute to
 * minute and is lost forever if missed; an article published this morning will
 * still be there tonight. Refreshing it every five minutes alongside the
 * scrapers would spend the run's budget on the part that matters least.
 */

import { rateLimited } from "@/lib/http";
import { fetchArticles } from "@/sources/news";
import { fetchRating, hasTmdbKey } from "@/sources/tmdb";
import type { State } from "@/store/types";

/** How stale a film's context may get before it is refreshed. */
const REFRESH_AFTER_HOURS = 6;

/** Films with almost no admissions are not worth a request. */
const MIN_ADMISSIONS = 50;

export type ContextResult = {
  refreshed: number;
  articles: number;
  ratings: number;
  errors: string[];
};

export async function refreshFilmContext(
  state: State,
  opts: { deadline: number; limit?: number },
): Promise<ContextResult> {
  const result: ContextResult = { refreshed: 0, articles: 0, ratings: 0, errors: [] };
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

  await rateLimited(
    due,
    async (film) => {
      const articles = await fetchArticles(film.title);
      film.articles = articles;
      result.articles += articles.length;

      if (hasTmdbKey()) {
        const rating = await fetchRating(film.title, film.originalTitle);
        if (rating) {
          film.rating = rating;
          result.ratings += 1;
        }
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
