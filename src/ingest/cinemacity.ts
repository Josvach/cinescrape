/**
 * Cinema City ingest.
 *
 * One request covers the entire chain, so this job snapshots every screening on
 * every run. The only extra traffic is a seatplan fetch per hall, which happens
 * once and is then cached — capacity is a property of the hall, not the show.
 */

import { db } from "@/db/client";
import { rateLimited } from "@/lib/http";
import {
  CAPACITY_RESIDUAL_TOLERANCE,
  fetchHallCapacity,
  fetchPresentations,
  normalize,
  seatsSoldFromRatio,
} from "@/sources/cinemacity";

import { recordSnapshot, resolveFilm, setHallCapacity, upsertCinema, upsertHall, upsertScreening } from "./repo";

/**
 * Cinema City publishes no prices in the feed, so revenue for this chain is an
 * estimate. Kept as a single knob rather than scattered through the stats code.
 */
export const CC_ESTIMATED_TICKET_PRICE_CZK = 205;

export type CcIngestResult = {
  presentations: number;
  snapshots: number;
  capacityFetches: number;
  staleCapacities: number;
  errors: string[];
};

export async function ingestCinemaCity(opts: { deadline: number }): Promise<CcIngestResult> {
  const d = db();
  const result: CcIngestResult = {
    presentations: 0,
    snapshots: 0,
    capacityFetches: 0,
    staleCapacities: 0,
    errors: [],
  };

  const presentations = await fetchPresentations();
  result.presentations = presentations.length;

  const cinemaIds = new Map<string, number>();
  const hallIds = new Map<string, { id: number; capacity: number | null }>();
  const filmIds = new Map<string, number>();
  /** Halls whose cached capacity no longer explains the ratios we are seeing. */
  const needsCapacity = new Map<string, { hallId: number; seatplanId: number; venueId: number }>();

  for (const p of presentations) {
    if (Date.now() >= opts.deadline) {
      result.errors.push("deadline reached before the feed was fully ingested");
      break;
    }

    try {
      const n = normalize(p);

      let cinemaId = cinemaIds.get(n.cinema.externalId);
      if (cinemaId === undefined) {
        cinemaId = await upsertCinema(d, {
          chain: n.chain,
          externalId: n.cinema.externalId,
          name: n.cinema.name,
          city: n.cinema.city,
        });
        cinemaIds.set(n.cinema.externalId, cinemaId);
      }

      const hallKey = `${cinemaId}:${n.hall.externalId}`;
      let hall = hallIds.get(hallKey);
      if (hall === undefined) {
        const row = await upsertHall(d, {
          cinemaId,
          externalId: n.hall.externalId,
          name: n.hall.name,
          seatplanExternalId: n.hall.seatplanExternalId,
        });
        hall = { id: row.id, capacity: row.capacity };
        hallIds.set(hallKey, hall);
      }

      let filmId = filmIds.get(n.film.externalId);
      if (filmId === undefined) {
        filmId = await resolveFilm(d, {
          chain: n.chain,
          externalId: n.film.externalId,
          title: n.film.title,
          originalTitle: n.film.originalTitle,
        });
        filmIds.set(n.film.externalId, filmId);
      }

      // Without a capacity the ratio means nothing yet; queue the seatplan and
      // still record the screening so it is not lost.
      if (hall.capacity == null) {
        needsCapacity.set(hallKey, {
          hallId: hall.id,
          seatplanId: Number(n.hall.seatplanExternalId),
          venueId: Number(n.hall.externalId),
        });
      }

      const screeningId = await upsertScreening(d, {
        chain: n.chain,
        externalId: n.externalId,
        filmId,
        hallId: hall.id,
        startsAt: n.startsAt,
        screeningDay: n.screeningDay,
        capacity: hall.capacity,
        formatAttrs: n.formatAttrs,
        languageVersion: n.languageVersion,
        soldOut: n.soldOut,
        priceSource: "estimate",
      });

      if (hall.capacity != null) {
        const { seatsSold, residual } = seatsSoldFromRatio(hall.capacity, n.availRatio);
        if (residual > CAPACITY_RESIDUAL_TOLERANCE) {
          // The hall was re-seated since we cached it. Refetch rather than
          // writing a seat count we know is wrong.
          result.staleCapacities += 1;
          needsCapacity.set(hallKey, {
            hallId: hall.id,
            seatplanId: Number(n.hall.seatplanExternalId),
            venueId: Number(n.hall.externalId),
          });
          continue;
        }
        await recordSnapshot(d, {
          screeningId,
          seatsSold,
          seatsTotal: hall.capacity,
        });
        result.snapshots += 1;
      }
    } catch (err) {
      result.errors.push(`presentation ${p.id}: ${String(err)}`);
    }
  }

  // Fetch missing capacities last so a slow seatplan endpoint cannot starve the
  // feed ingest. They are picked up on the next run.
  const pending = [...needsCapacity.values()];
  await rateLimited(
    pending,
    async (item) => {
      const capacity = await fetchHallCapacity(item.seatplanId, item.venueId);
      if (capacity > 0) {
        await setHallCapacity(d, item.hallId, capacity);
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
