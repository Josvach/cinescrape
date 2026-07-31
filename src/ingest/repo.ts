import { and, eq, sql } from "drizzle-orm";

import { db, schema } from "@/db/client";

import { filmIdentity } from "./match";

type Db = ReturnType<typeof db>;

export async function upsertCinema(
  d: Db,
  input: { chain: string; externalId: string; name: string; city?: string | null },
): Promise<number> {
  const [row] = await d
    .insert(schema.cinemas)
    .values({
      chain: input.chain,
      externalId: input.externalId,
      name: input.name,
      city: input.city ?? null,
    })
    .onConflictDoUpdate({
      target: [schema.cinemas.chain, schema.cinemas.externalId],
      set: { name: input.name, city: input.city ?? null },
    })
    .returning({ id: schema.cinemas.id });
  return row.id;
}

export async function upsertHall(
  d: Db,
  input: {
    cinemaId: number;
    externalId: string;
    name?: string | null;
    seatplanExternalId?: string | null;
    capacity?: number | null;
  },
): Promise<{ id: number; capacity: number | null; seatplanExternalId: string | null }> {
  const [row] = await d
    .insert(schema.halls)
    .values({
      cinemaId: input.cinemaId,
      externalId: input.externalId,
      name: input.name ?? null,
      seatplanExternalId: input.seatplanExternalId ?? null,
      capacity: input.capacity ?? null,
      capacityUpdatedAt: input.capacity != null ? new Date() : null,
    })
    .onConflictDoUpdate({
      target: [schema.halls.cinemaId, schema.halls.externalId],
      set: {
        name: input.name ?? sql`${schema.halls.name}`,
        seatplanExternalId: input.seatplanExternalId ?? sql`${schema.halls.seatplanExternalId}`,
      },
    })
    .returning({
      id: schema.halls.id,
      capacity: schema.halls.capacity,
      seatplanExternalId: schema.halls.seatplanExternalId,
    });
  return row;
}

export async function setHallCapacity(d: Db, hallId: number, capacity: number): Promise<void> {
  await d
    .update(schema.halls)
    .set({ capacity, capacityUpdatedAt: new Date() })
    .where(eq(schema.halls.id, hallId));
}

/**
 * Resolve a chain's film to our canonical row.
 *
 * The alias table short-circuits the common case, so a title that has already
 * been seen never re-runs the fuzzy path. On a miss we try the exact key, then
 * the space-collapsed key, and only then create a film.
 */
export async function resolveFilm(
  d: Db,
  input: { chain: string; externalId: string; title: string; originalTitle: string | null },
): Promise<number> {
  const existingAlias = await d
    .select({ filmId: schema.filmAliases.filmId })
    .from(schema.filmAliases)
    .where(
      and(
        eq(schema.filmAliases.chain, input.chain),
        eq(schema.filmAliases.externalId, input.externalId),
      ),
    )
    .limit(1);
  if (existingAlias.length) return existingAlias[0].filmId;

  const identity = filmIdentity(input.title, input.originalTitle);

  let filmId: number | undefined;
  const byMatchKey = await d
    .select({ id: schema.films.id })
    .from(schema.films)
    .where(eq(schema.films.matchKey, identity.matchKey))
    .limit(1);
  filmId = byMatchKey[0]?.id;

  if (!filmId) {
    const byTightKey = await d
      .select({ id: schema.films.id })
      .from(schema.films)
      .where(eq(schema.films.tightKey, identity.tightKey))
      .limit(1);
    filmId = byTightKey[0]?.id;
  }

  if (!filmId) {
    const [created] = await d
      .insert(schema.films)
      .values({
        matchKey: identity.matchKey,
        tightKey: identity.tightKey,
        title: identity.title,
        originalTitle: identity.originalTitle,
      })
      // A concurrent cron run may have inserted the same film first.
      .onConflictDoUpdate({
        target: schema.films.matchKey,
        set: { title: identity.title },
      })
      .returning({ id: schema.films.id });
    filmId = created.id;
  }

  await d
    .insert(schema.filmAliases)
    .values({
      filmId,
      chain: input.chain,
      externalId: input.externalId,
      rawTitle: input.title,
    })
    .onConflictDoNothing({
      target: [schema.filmAliases.chain, schema.filmAliases.externalId],
    });

  return filmId;
}

export type ScreeningUpsert = {
  chain: string;
  externalId: string;
  filmId: number;
  hallId: number;
  startsAt: Date;
  screeningDay: string;
  capacity: number | null;
  formatAttrs: string[];
  languageVersion: string | null;
  soldOut: boolean;
  priceMin?: number | null;
  priceMax?: number | null;
  priceSource?: string | null;
  nextPollAt?: Date | null;
};

export type ScreeningState = {
  id: number;
  currentSeatsSold: number | null;
  currentAt: Date | null;
};

export async function upsertScreening(d: Db, input: ScreeningUpsert): Promise<ScreeningState> {
  const [row] = await d
    .insert(schema.screenings)
    .values({
      ...input,
      priceMin: input.priceMin != null ? String(input.priceMin) : null,
      priceMax: input.priceMax != null ? String(input.priceMax) : null,
      priceSource: input.priceSource ?? null,
      nextPollAt: input.nextPollAt ?? null,
      lastSeenAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [schema.screenings.chain, schema.screenings.externalId],
      set: {
        startsAt: input.startsAt,
        screeningDay: input.screeningDay,
        capacity: input.capacity,
        soldOut: input.soldOut,
        formatAttrs: input.formatAttrs,
        lastSeenAt: new Date(),
      },
    })
    .returning({
      id: schema.screenings.id,
      currentSeatsSold: schema.screenings.currentSeatsSold,
      currentAt: schema.screenings.currentAt,
    });
  return row;
}

/**
 * Record a reading.
 *
 * Two separate concerns share this call. The mirrored `current_*` columns are
 * the live figure every dashboard query reads, and they are refreshed whenever
 * the number moves. The snapshot table is the history behind the ramp charts,
 * and it is only appended to when `recordHistory` says the reading is worth
 * keeping — see `shouldRecordSnapshot`.
 */
export async function recordSnapshot(
  d: Db,
  input: {
    screeningId: number;
    seatsSold: number;
    seatsTotal: number;
    capturedAt?: Date;
    recordHistory?: boolean;
    priceMin?: number | null;
    priceMax?: number | null;
    priceSource?: string | null;
    nextPollAt?: Date | null;
  },
): Promise<void> {
  const capturedAt = input.capturedAt ?? new Date();

  if (input.recordHistory !== false) {
    await d.insert(schema.screeningSnapshots).values({
      screeningId: input.screeningId,
      capturedAt,
      seatsSold: input.seatsSold,
      seatsTotal: input.seatsTotal,
    });
  }

  await d
    .update(schema.screenings)
    .set({
      currentSeatsSold: input.seatsSold,
      currentSeatsTotal: input.seatsTotal,
      currentAt: capturedAt,
      capacity: input.seatsTotal,
      lastPolledAt: capturedAt,
      ...(input.nextPollAt !== undefined ? { nextPollAt: input.nextPollAt } : {}),
      ...(input.priceMin != null ? { priceMin: String(input.priceMin) } : {}),
      ...(input.priceMax != null ? { priceMax: String(input.priceMax) } : {}),
      ...(input.priceSource ? { priceSource: input.priceSource } : {}),
    })
    .where(eq(schema.screenings.id, input.screeningId));
}

export async function startJobRun(d: Db, job: string): Promise<number> {
  const [row] = await d
    .insert(schema.jobRuns)
    .values({ job })
    .returning({ id: schema.jobRuns.id });
  return row.id;
}

export async function finishJobRun(
  d: Db,
  id: number,
  input: { ok: boolean; itemsProcessed: number; note?: string },
): Promise<void> {
  await d
    .update(schema.jobRuns)
    .set({
      finishedAt: new Date(),
      ok: input.ok,
      itemsProcessed: input.itemsProcessed,
      note: input.note?.slice(0, 2000) ?? null,
    })
    .where(eq(schema.jobRuns.id, id));
}
