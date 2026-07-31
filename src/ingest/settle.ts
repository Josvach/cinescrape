/**
 * Freezing the final admissions figure for screenings that have already run.
 *
 * Neither chain lets us read a screening once it has started, and both drop it
 * from their feeds shortly afterwards. Whatever we captured before showtime is
 * therefore the permanent record, and this job writes it down together with an
 * honest confidence flag rather than pretending every number is equally good.
 */

import { and, desc, eq, isNull, lt, sql } from "drizzle-orm";

import { db, schema } from "@/db/client";

import { settleConfidence } from "./schedule";

/**
 * Wait a little after showtime before settling, so a poll that was in flight as
 * the screening began still counts.
 */
const SETTLE_GRACE_MS = 30 * 60_000;

export type SettleResult = {
  settled: number;
  byConfidence: Record<string, number>;
};

export async function settleScreenings(opts: {
  deadline: number;
  batchSize?: number;
}): Promise<SettleResult> {
  const d = db();
  const result: SettleResult = { settled: 0, byConfidence: {} };
  const cutoff = new Date(Date.now() - SETTLE_GRACE_MS);

  const pending = await d
    .select({
      id: schema.screenings.id,
      startsAt: schema.screenings.startsAt,
      capacity: schema.screenings.capacity,
    })
    .from(schema.screenings)
    .leftJoin(
      schema.screeningsSettled,
      eq(schema.screeningsSettled.screeningId, schema.screenings.id),
    )
    .where(
      and(lt(schema.screenings.startsAt, cutoff), isNull(schema.screeningsSettled.screeningId)),
    )
    .orderBy(desc(schema.screenings.startsAt))
    .limit(opts.batchSize ?? 2000);

  for (const row of pending) {
    if (Date.now() >= opts.deadline) break;

    const [latest] = await d
      .select({
        seatsSold: schema.screeningSnapshots.seatsSold,
        seatsTotal: schema.screeningSnapshots.seatsTotal,
        capturedAt: schema.screeningSnapshots.capturedAt,
      })
      .from(schema.screeningSnapshots)
      .where(eq(schema.screeningSnapshots.screeningId, row.id))
      .orderBy(desc(schema.screeningSnapshots.capturedAt))
      .limit(1);

    const confidence = settleConfidence(row.startsAt, latest?.capturedAt ?? null);

    await d
      .insert(schema.screeningsSettled)
      .values({
        screeningId: row.id,
        seatsSold: latest?.seatsSold ?? 0,
        seatsTotal: latest?.seatsTotal ?? row.capacity ?? 0,
        confidence,
        capturedAt: latest?.capturedAt ?? null,
      })
      .onConflictDoNothing({ target: schema.screeningsSettled.screeningId });

    // A settled screening never needs polling again.
    await d
      .update(schema.screenings)
      .set({ nextPollAt: null })
      .where(eq(schema.screenings.id, row.id));

    result.settled += 1;
    result.byConfidence[confidence] = (result.byConfidence[confidence] ?? 0) + 1;
  }

  return result;
}

/**
 * Share of recently settled screenings we failed to capture.
 *
 * Surfaced in the UI so a reader can tell the difference between "this film
 * sold little" and "we did not manage to measure it".
 */
export async function recentCoverage(days = 7): Promise<{
  total: number;
  missed: number;
  partial: number;
}> {
  const d = db();
  const [row] = await d
    .select({
      total: sql<number>`count(*)::int`,
      missed: sql<number>`count(*) filter (where ${schema.screeningsSettled.confidence} = 'missed')::int`,
      partial: sql<number>`count(*) filter (where ${schema.screeningsSettled.confidence} = 'partial')::int`,
    })
    .from(schema.screeningsSettled)
    .innerJoin(schema.screenings, eq(schema.screenings.id, schema.screeningsSettled.screeningId))
    .where(sql`${schema.screenings.startsAt} > now() - make_interval(days => ${days})`);

  return row ?? { total: 0, missed: 0, partial: 0 };
}
