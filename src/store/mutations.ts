import { filmIdentity } from "@/core/match";

import { key, type Chain, type Key, type RampBucket, type Screening, type State } from "./types";

export function upsertCinema(
  state: State,
  input: { chain: Chain; externalId: string; name: string; city?: string | null },
): Key {
  const k = key(input.chain, input.externalId);
  state.cinemas[k] = { chain: input.chain, name: input.name, city: input.city ?? null };
  return k;
}

export function upsertHall(
  state: State,
  input: {
    chain: Chain;
    externalId: string;
    cinemaKey: Key;
    name?: string | null;
    seatplanId?: string | null;
  },
): Key {
  const k = key(input.chain, input.externalId);
  const existing = state.halls[k];
  state.halls[k] = {
    cinemaKey: input.cinemaKey,
    name: input.name ?? existing?.name ?? null,
    // Capacity is learned separately and must survive a metadata refresh.
    capacity: existing?.capacity ?? null,
    seatplanId: input.seatplanId ?? existing?.seatplanId ?? null,
  };
  return k;
}

export function setHallCapacity(state: State, hallKey: Key, capacity: number): void {
  const hall = state.halls[hallKey];
  if (hall) hall.capacity = capacity;
}

/**
 * Resolve a chain's film to our canonical one.
 *
 * The alias map short-circuits everything already seen. On a miss we try the
 * exact normalized original title, then the space-collapsed variant that
 * bridges the chains' differing transliterations, and only then mint a film.
 */
export function resolveFilm(
  state: State,
  input: { chain: Chain; externalId: string; title: string; originalTitle: string | null },
): number {
  const aliasKey = key(input.chain, input.externalId);
  const known = state.filmAliases[aliasKey];
  if (known !== undefined) return known;

  const identity = filmIdentity(input.title, input.originalTitle);
  let film = state.films.find((f) => f.matchKey === identity.matchKey);
  if (!film) film = state.films.find((f) => f.tightKey === identity.tightKey);

  if (!film) {
    film = {
      id: state.nextFilmId++,
      matchKey: identity.matchKey,
      tightKey: identity.tightKey,
      title: identity.title,
      originalTitle: identity.originalTitle,
    };
    state.films.push(film);
  }

  state.filmAliases[aliasKey] = film.id;
  return film.id;
}

export type ScreeningInput = {
  chain: Chain;
  externalId: string;
  filmId: number;
  hallKey: Key;
  startsAt: Date;
  day: string;
  formats: string[];
  lang: string | null;
  soldOut: boolean;
  nextPollAt?: Date | null;
};

export function upsertScreening(state: State, input: ScreeningInput): Screening {
  const k = key(input.chain, input.externalId);
  const existing = state.screenings[k];

  if (existing) {
    existing.startsAt = input.startsAt.toISOString();
    existing.day = input.day;
    existing.formats = input.formats;
    existing.soldOut = input.soldOut;
    return existing;
  }

  const created: Screening = {
    chain: input.chain,
    filmId: input.filmId,
    hallKey: input.hallKey,
    startsAt: input.startsAt.toISOString(),
    day: input.day,
    sold: null,
    total: null,
    at: null,
    nextPollAt: (input.nextPollAt ?? null)?.toISOString() ?? null,
    formats: input.formats,
    lang: input.lang,
    soldOut: input.soldOut,
    priceMin: null,
    priceMax: null,
  };
  state.screenings[k] = created;
  return created;
}

/** `YYYY-MM-DDTHH` in UTC — the ramp chart's bucket granularity. */
export const rampBucketKey = (at: Date) => at.toISOString().slice(0, 13);

/**
 * Record a reading and credit any increase to the sales ramp.
 *
 * Only the *increase* since the previous reading is added, so the ramp measures
 * tickets sold per hour rather than re-counting the standing total. A screening
 * seen for the first time contributes nothing: whatever it had already sold
 * happened before we were watching, and booking it as this hour's sales would
 * invent a spike.
 */
export function recordReading(
  state: State,
  screening: Screening,
  input: { sold: number; total: number; at?: Date; priceMin?: number | null; priceMax?: number | null },
): void {
  const at = input.at ?? new Date();
  const first = screening.sold === null;
  const delta = first ? 0 : input.sold - screening.sold!;

  screening.sold = input.sold;
  screening.total = input.total;
  screening.at = at.toISOString();
  if (input.priceMin != null) screening.priceMin = input.priceMin;
  if (input.priceMax != null) screening.priceMax = input.priceMax;

  // Refunds and released holds make the count go down; they are real, but they
  // are not sales, and letting them subtract would understate the ramp.
  if (delta <= 0) return;

  const bucketKey = rampBucketKey(at);
  let bucket: RampBucket | undefined = state.ramp[state.ramp.length - 1];
  if (!bucket || bucket.at !== bucketKey) {
    bucket = state.ramp.find((b) => b.at === bucketKey);
    if (!bucket) {
      bucket = { at: bucketKey, byFilm: {} };
      state.ramp.push(bucket);
      state.ramp.sort((a, b) => a.at.localeCompare(b.at));
    }
  }
  const id = String(screening.filmId);
  bucket.byFilm[id] = (bucket.byFilm[id] ?? 0) + delta;
}
