/**
 * Audience rating, from The Movie Database.
 *
 * ČSFD would be the natural source for a Czech audience — it is the rating
 * people here actually quote — but it has no public API and serves a
 * proof-of-work challenge to anything that is not a browser. Defeating that is
 * not something this project does, so the rating comes from TMDB instead: a
 * real API, free, and explicit about allowing this.
 *
 * Entirely optional. Without TMDB_API_KEY the dashboard simply shows no rating.
 */

import { fetchJson } from "@/lib/http";

const BASE = "https://api.themoviedb.org/3";

type TmdbSearch = {
  results: {
    id: number;
    title: string;
    original_title: string;
    release_date: string;
    vote_average: number;
    vote_count: number;
  }[];
};

export type Rating = {
  /** 0–100, the way audiences read it. */
  percent: number;
  votes: number;
  tmdbId: number;
};

export const hasTmdbKey = () => Boolean(process.env.TMDB_API_KEY);

/**
 * Look a film up by its original title, falling back to the Czech one.
 *
 * A rating backed by a handful of votes says nothing, so those are discarded
 * rather than displayed as if they meant something.
 */
export async function fetchRating(
  title: string,
  originalTitle: string | null,
  minVotes = 20,
): Promise<Rating | null> {
  const key = process.env.TMDB_API_KEY;
  if (!key) return null;

  for (const query of [originalTitle, title].filter(Boolean) as string[]) {
    const res = await fetchJson<TmdbSearch>(
      `${BASE}/search/movie?api_key=${key}&language=cs-CZ&query=${encodeURIComponent(query)}`,
      { timeoutMs: 15_000 },
    );
    const hit = res.results?.[0];
    if (!hit || hit.vote_count < minVotes || !hit.vote_average) continue;
    return {
      percent: Math.round(hit.vote_average * 10),
      votes: hit.vote_count,
      tmdbId: hit.id,
    };
  }
  return null;
}
