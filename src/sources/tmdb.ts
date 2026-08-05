/**
 * Audience rating, from The Movie Database.
 *
 * The fallback, not the first choice: ČSFD is the rating Czech audiences
 * quote, and `sources/csfd.ts` reads it now. TMDB covers what ČSFD's cinema
 * listing does not — a re-release, a film that premiered in an earlier year —
 * and needs no scraping at all, just a free API key.
 *
 * Entirely optional. Without TMDB_API_KEY the dashboard falls back to ČSFD
 * alone.
 */

import { fetchJson } from "@/lib/http";
import type { Rating } from "@/store/types";

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
      source: "tmdb",
      tmdbId: hit.id,
    };
  }
  return null;
}
