/**
 * The whole dataset, as plain JSON on disk.
 *
 * There is no database. For one person tracking two cinema chains the working
 * set is a couple of megabytes, which fits in memory and in a git commit, and
 * dropping Postgres removes the only piece of the stack that needed an account,
 * a password and a paid tier to stay awake.
 *
 * Three files, with different lifetimes:
 *
 *   state.json    the live working set — every screening still on sale, plus
 *                 the recent past waiting to be settled. Rewritten every run.
 *   history.json  permanent per-day, per-film totals. Append-only, small.
 *   live.json     precomputed answers for the dashboard. Derived; disposable.
 */

export type Chain = "cinema_city" | "cinestar";

/** `chain:externalId` — stable across runs, unlike an autoincrement id. */
export type Key = string;

export const key = (chain: Chain, externalId: string): Key => `${chain}:${externalId}`;

export type Cinema = {
  chain: Chain;
  name: string;
  city: string | null;
};

export type Hall = {
  cinemaKey: Key;
  name: string | null;
  capacity: number | null;
  /** Cinema City needs this alongside the hall id to fetch a seatplan. */
  seatplanId: string | null;
};

export type Article = {
  title: string;
  url: string;
  source: string;
  publishedAt: string;
  isReview: boolean;
};

export type Rating = {
  /** 0–100. */
  percent: number;
  votes: number;
  tmdbId: number;
};

export type Film = {
  id: number;
  matchKey: string;
  tightKey: string;
  title: string;
  originalTitle: string | null;
  /** Press coverage and reviews; refreshed on a much slower beat than occupancy. */
  articles?: Article[];
  rating?: Rating;
  /** ISO instant of the last context refresh. */
  contextAt?: string;
};

export type SettleConfidence = "final" | "partial" | "missed";

export type Settled = {
  sold: number;
  total: number;
  confidence: SettleConfidence;
  /** ISO instant of the reading we settled from, or null when there was none. */
  capturedAt: string | null;
};

export type Screening = {
  chain: Chain;
  filmId: number;
  hallKey: Key;
  /** ISO instant. */
  startsAt: string;
  /** `YYYY-MM-DD` cinema day the admissions belong to. */
  day: string;
  sold: number | null;
  total: number | null;
  /** ISO instant of the last reading. */
  at: string | null;
  /** ISO instant; null once the screening has left the poll queue. */
  nextPollAt: string | null;
  formats: string[];
  lang: string | null;
  soldOut: boolean;
  priceMin: number | null;
  priceMax: number | null;
  settled?: Settled;
};

/**
 * One hourly bucket of measured sales.
 *
 * Only deltas are stored, never running totals — a bucket says "this many
 * tickets were sold during this hour", which is what the ramp chart integrates.
 * Storing cumulative values instead would double-count the moment a screening
 * is added or removed from the window.
 */
export type RampBucket = {
  /** `YYYY-MM-DDTHH`, in UTC. */
  at: string;
  /** Tickets sold in this hour, keyed by film id. */
  byFilm: Record<string, number>;
};

export type State = {
  version: 1;
  updatedAt: string;
  cinemas: Record<Key, Cinema>;
  halls: Record<Key, Hall>;
  films: Film[];
  /** Per-chain external id → film id. */
  filmAliases: Record<Key, number>;
  /**
   * CineStar `TitleId` → our film id.
   *
   * The programme pages give every screening a TitleId but never a title, so
   * one `event/get` is needed to name each one. Remembering the answer turns
   * that into one lookup per film version rather than one per screening —
   * roughly 80 requests instead of 2400.
   */
  cineStarTitles: Record<string, number>;
  screenings: Record<Key, Screening>;
  ramp: RampBucket[];
  nextFilmId: number;
};

export type HistoryDay = {
  /** Film id → totals for that cinema day. */
  films: Record<string, { sold: number; capacity: number; screenings: number; gross: number }>;
  /** How many of the day's screenings we actually measured in time. */
  coverage: { total: number; final: number; partial: number; missed: number };
};

/** One film's line in one UFD weekly report. */
export type UfdEntry = {
  rank: number;
  title: string;
  distributor: string;
  weekOfRun: number;
  cinemas: number;
  weekendAdmissions: number;
  weekendGross: number;
  totalAdmissions: number;
  totalGross: number;
  /** Our film id, when the title could be matched to something we track. */
  filmId?: number;
};

export type UfdWeekRecord = {
  year: number;
  week: number;
  /** `YYYY-MM-DD`, the Thursday the weekend opened on. */
  weekendFrom: string;
  entries: UfdEntry[];
};

export type History = {
  version: 1;
  /** `YYYY-MM-DD` → totals. */
  days: Record<string, HistoryDay>;
  /** Film id → display metadata, so history stays readable on its own. */
  films: Record<string, { title: string; originalTitle: string | null }>;
  /**
   * Official weekly results, keyed `YYYY-Www`.
   *
   * Authoritative for everything up to the last published Monday: national
   * rather than our two-chain sample, and the figure the industry quotes. The
   * scraping covers the days since.
   */
  ufd?: Record<string, UfdWeekRecord>;
  /** ISO instant of the last successful UFD refresh. */
  ufdCheckedAt?: string;
};

export function emptyState(): State {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    cinemas: {},
    halls: {},
    films: [],
    filmAliases: {},
    cineStarTitles: {},
    screenings: {},
    ramp: [],
    nextFilmId: 1,
  };
}

export function emptyHistory(): History {
  return { version: 1, days: {}, films: {} };
}
