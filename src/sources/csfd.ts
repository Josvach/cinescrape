/**
 * Audience rating from ČSFD.
 *
 * This is the rating Czech audiences actually quote, which is why it is worth
 * having even though TMDB is easier to talk to.
 *
 * On access: csfd.cz publishes a robots.txt that names several AI crawlers and
 * disallows them outright, and blocks its search and a handful of query
 * parameters for everyone. Film pages are not among them, and `/kino/` is not
 * either. This client stays inside that: it reads the cinema listing and the
 * film pages it links to, never `/hledat`, never the disallowed parameters,
 * and identifies itself with the operator's contact address. The operator has
 * also agreed the arrangement with ČSFD directly, who cannot loosen robots.txt
 * without loosening it for everyone.
 *
 * The rating itself comes from the schema.org `aggregateRating` block the page
 * already publishes for machines, rather than from scraping presentation
 * markup, so it does not break when they restyle the page.
 */

import { fetchText } from "@/lib/http";

const BASE = "https://www.csfd.cz";

/**
 * This year's cinema releases — a few hundred titles, which comfortably covers
 * everything the chains are playing. The `/kino/` front page only carries the
 * ten-film "hottest today" slider, which is not enough.
 */
const CINEMA_INDEX = `${BASE}/kino/prehled/`;

export type CsfdFilm = {
  /** ČSFD's numeric film id. */
  id: string;
  /** `/film/1580037-odyssea` — the path, without a trailing section. */
  path: string;
  title: string;
};

export type CsfdRating = {
  /** 0–100, the way ČSFD shows it. */
  percent: number;
  votes: number;
  csfdId: string;
  url: string;
};

const decodeEntities = (s: string): string =>
  s
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

/**
 * Read the film links out of the cinema listing.
 *
 * Their search is disallowed in robots.txt, so this listing is how a film is
 * found at all — and it happens to be the right set anyway: what is in cinemas
 * now is what the dashboard is about.
 */
export function parseCinemaIndex(html: string): CsfdFilm[] {
  const found = new Map<string, CsfdFilm>();
  // The listing renders each film as a linked title; the front page's slider
  // puts the name in a `title` attribute instead. Both are read, first wins.
  for (const m of html.matchAll(
    /href="(\/film\/(\d+)-[^"/]+)\/[a-z-]*\/?"(?:[^>]*title="([^"]*)")?[^>]*>([^<]*)</g,
  )) {
    if (found.has(m[2])) continue;
    const title = decodeEntities(m[3] || m[4] || "").trim();
    if (!title) continue;
    found.set(m[2], { id: m[2], path: m[1], title });
  }
  return [...found.values()];
}

export async function fetchCinemaIndex(): Promise<CsfdFilm[]> {
  return parseCinemaIndex(await fetchText(CINEMA_INDEX, { timeoutMs: 30_000 }));
}

/**
 * Pull the rating out of the page's schema.org block.
 *
 * A rating standing on a handful of votes says nothing, so it is discarded
 * rather than shown as if it did — the same rule the TMDB client uses.
 */
export function parseRating(html: string, film: CsfdFilm, minVotes = 20): CsfdRating | null {
  const block = html.match(/"aggregateRating"\s*:\s*\{([^}]*)\}/);
  if (!block) return null;

  const value = block[1].match(/"ratingValue"\s*:\s*([\d.]+)/);
  const count = block[1].match(/"ratingCount"\s*:\s*(\d+)/);
  if (!value || !count) return null;

  const votes = Number(count[1]);
  const percent = Math.round(Number(value[1]));
  // An unrated film renders as "? %" and reports no meaningful aggregate.
  if (!Number.isFinite(percent) || percent <= 0 || votes < minVotes) return null;

  return { percent, votes, csfdId: film.id, url: `${BASE}${film.path}/prehled/` };
}

export async function fetchRating(film: CsfdFilm): Promise<CsfdRating | null> {
  const html = await fetchText(`${BASE}${film.path}/prehled/`, { timeoutMs: 30_000 });
  return parseRating(html, film);
}
