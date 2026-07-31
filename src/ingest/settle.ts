/**
 * Freezing final admissions, and moving them out of the working set.
 *
 * Neither chain lets us read a screening once it has started, and both drop it
 * from their feeds soon after. Whatever we captured before showtime is the
 * permanent record, so it is written down together with an honest confidence
 * flag rather than pretending every number is equally solid.
 *
 * Settled screenings are then folded into `history.json` as per-day, per-film
 * totals and deleted from `state.json`. That is what keeps the working set
 * proportional to what is currently on sale instead of growing forever.
 */

import { settleConfidence } from "@/core/schedule";
import { CC_ESTIMATED_TICKET_PRICE_CZK } from "@/ingest/cinemacity";
import type { History, HistoryDay, State } from "@/store/types";

/** Wait a little after showtime, so a reading in flight as it began still counts. */
const SETTLE_GRACE_MS = 30 * 60_000;

/**
 * How long a settled screening stays in the working set before it is folded
 * into history. A few days is enough for the dashboard's recent-days view to
 * read per-screening detail; beyond that the daily totals are all anyone wants.
 */
const FOLD_AFTER_DAYS = 10;

/** Hours of ramp detail kept. Older buckets stop being interesting. */
const RAMP_RETENTION_HOURS = 24 * 21;

export type SettleResult = {
  settled: number;
  folded: number;
  byConfidence: Record<string, number>;
};

export function settleScreenings(state: State, history: History): SettleResult {
  const result: SettleResult = { settled: 0, folded: 0, byConfidence: {} };
  const now = Date.now();
  const cutoff = now - SETTLE_GRACE_MS;

  for (const screening of Object.values(state.screenings)) {
    if (screening.settled) continue;
    const startsAt = new Date(screening.startsAt);
    if (startsAt.getTime() >= cutoff) continue;

    const capturedAt = screening.at ? new Date(screening.at) : null;
    const confidence = settleConfidence(startsAt, capturedAt);

    screening.settled = {
      sold: screening.sold ?? 0,
      total: screening.total ?? 0,
      confidence,
      capturedAt: screening.at,
    };
    screening.nextPollAt = null;

    result.settled += 1;
    result.byConfidence[confidence] = (result.byConfidence[confidence] ?? 0) + 1;
  }

  result.folded = foldIntoHistory(state, history, now);
  pruneRamp(state, now);
  return result;
}

function foldIntoHistory(state: State, history: History, now: number): number {
  const foldBefore = now - FOLD_AFTER_DAYS * 24 * 60 * 60 * 1000;
  let folded = 0;

  for (const [k, s] of Object.entries(state.screenings)) {
    if (!s.settled) continue;
    if (new Date(s.startsAt).getTime() >= foldBefore) continue;

    const day: HistoryDay = (history.days[s.day] ??= {
      films: {},
      coverage: { total: 0, final: 0, partial: 0, missed: 0 },
    });

    const id = String(s.filmId);
    const totals = (day.films[id] ??= { sold: 0, capacity: 0, screenings: 0, gross: 0 });
    totals.sold += s.settled.sold;
    totals.capacity += s.settled.total;
    totals.screenings += 1;
    totals.gross += s.settled.sold * (s.priceMin ?? CC_ESTIMATED_TICKET_PRICE_CZK);

    day.coverage.total += 1;
    day.coverage[s.settled.confidence] += 1;

    const film = state.films.find((f) => f.id === s.filmId);
    if (film) history.films[id] = { title: film.title, originalTitle: film.originalTitle };

    delete state.screenings[k];
    folded += 1;
  }

  return folded;
}

function pruneRamp(state: State, now: number): void {
  const cutoff = new Date(now - RAMP_RETENTION_HOURS * 60 * 60 * 1000).toISOString().slice(0, 13);
  state.ramp = state.ramp.filter((b) => b.at >= cutoff);
}

/**
 * Share of recently settled screenings we failed to capture in time.
 *
 * Surfaced in the UI so a reader can tell "this film sold little" apart from
 * "we did not manage to measure it".
 */
export function recentCoverage(
  state: State,
  history: History,
  days = 7,
): { total: number; missed: number; partial: number } {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  let total = 0;
  let missed = 0;
  let partial = 0;

  for (const s of Object.values(state.screenings)) {
    if (!s.settled || s.startsAt < since) continue;
    total += 1;
    if (s.settled.confidence === "missed") missed += 1;
    if (s.settled.confidence === "partial") partial += 1;
  }

  const sinceDay = since.slice(0, 10);
  for (const [day, d] of Object.entries(history.days)) {
    if (day < sinceDay) continue;
    total += d.coverage.total;
    missed += d.coverage.missed;
    partial += d.coverage.partial;
  }

  return { total, missed, partial };
}
