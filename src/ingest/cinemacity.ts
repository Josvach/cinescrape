/**
 * Cinema City ingest.
 *
 * One request covers the entire chain, so every screening is re-read on every
 * run. The only extra traffic is a seatplan fetch per hall, which happens once
 * and is then remembered — capacity belongs to the hall, not to the showing.
 */

import { rateLimited } from "@/lib/http";
import {
  CAPACITY_RESIDUAL_TOLERANCE,
  fetchHallCapacity,
  fetchPresentations,
  normalize,
  seatsSoldFromRatio,
} from "@/sources/cinemacity";
import {
  recordReading,
  resolveFilm,
  setHallCapacity,
  upsertCinema,
  upsertHall,
  upsertScreening,
} from "@/store/mutations";
import type { State } from "@/store/types";

/**
 * Cinema City publishes no prices, so its revenue figure is an estimate. One
 * knob, stated once, rather than a number scattered through the stats code.
 */
export const CC_ESTIMATED_TICKET_PRICE_CZK = 205;

export type CcIngestResult = {
  presentations: number;
  read: number;
  capacityFetches: number;
  staleCapacities: number;
  errors: string[];
};

export async function ingestCinemaCity(
  state: State,
  opts: { deadline: number },
): Promise<CcIngestResult> {
  const result: CcIngestResult = {
    presentations: 0,
    read: 0,
    capacityFetches: 0,
    staleCapacities: 0,
    errors: [],
  };

  const presentations = await fetchPresentations();
  result.presentations = presentations.length;

  /** Halls whose remembered capacity no longer explains the ratios we see. */
  const needsCapacity = new Map<string, { hallKey: string; seatplanId: number; venueId: number }>();

  for (const p of presentations) {
    try {
      const n = normalize(p);

      const cinemaKey = upsertCinema(state, {
        chain: n.chain,
        externalId: n.cinema.externalId,
        name: n.cinema.name,
        city: n.cinema.city,
      });

      const hallKey = upsertHall(state, {
        chain: n.chain,
        externalId: n.hall.externalId,
        cinemaKey,
        name: n.hall.name,
        seatplanId: n.hall.seatplanExternalId,
      });

      const filmId = resolveFilm(state, {
        chain: n.chain,
        externalId: n.film.externalId,
        title: n.film.title,
        originalTitle: n.film.originalTitle,
      });

      const screening = upsertScreening(state, {
        chain: n.chain,
        externalId: n.externalId,
        filmId,
        hallKey,
        startsAt: n.startsAt,
        day: n.screeningDay,
        formats: n.formatAttrs,
        lang: n.languageVersion,
        soldOut: n.soldOut,
      });

      const capacity = state.halls[hallKey]?.capacity ?? null;
      if (capacity == null) {
        // Without a capacity the ratio means nothing yet. The screening is
        // still recorded so it is not lost; the reading arrives next run.
        needsCapacity.set(hallKey, {
          hallKey,
          seatplanId: Number(n.hall.seatplanExternalId),
          venueId: Number(n.hall.externalId),
        });
        continue;
      }

      const { seatsSold, residual } = seatsSoldFromRatio(capacity, n.availRatio);
      if (residual > CAPACITY_RESIDUAL_TOLERANCE) {
        // The hall was re-seated since we measured it. Refetch rather than
        // write a seat count we already know is wrong.
        result.staleCapacities += 1;
        needsCapacity.set(hallKey, {
          hallKey,
          seatplanId: Number(n.hall.seatplanExternalId),
          venueId: Number(n.hall.externalId),
        });
        continue;
      }

      recordReading(state, screening, { sold: seatsSold, total: capacity });
      result.read += 1;
    } catch (err) {
      result.errors.push(`presentation ${p.id}: ${String(err)}`);
    }
  }

  // Capacities last, so a slow seatplan endpoint cannot starve the feed ingest.
  // Whatever does not fit in the budget is picked up on the next run.
  await rateLimited(
    [...needsCapacity.values()],
    async (item) => {
      const capacity = await fetchHallCapacity(item.seatplanId, item.venueId);
      if (capacity > 0) {
        setHallCapacity(state, item.hallKey, capacity);
        result.capacityFetches += 1;
      }
    },
    {
      minIntervalMs: 350,
      deadline: opts.deadline,
      onError: (item, err) => result.errors.push(`seatplan ${item.venueId}: ${String(err)}`),
    },
  );

  return result;
}
