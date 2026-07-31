/**
 * CineStar ingest, split into two jobs.
 *
 * `discoverCineStarSchedule` walks the 13 programme pages and registers any new
 * screening, paying one `event/get` per screening it has never seen. Metadata
 * does not change, so that cost is paid once per screening rather than per poll.
 *
 * `pollCineStarHalls` then works a priority queue of `hall/get` calls until its
 * time budget runs out. It never tries to drain the queue: a cron function has
 * a hard ceiling, and stopping cleanly mid-queue is better than being killed.
 */

import { and, asc, eq, isNotNull, lte } from "drizzle-orm";

import { db, schema } from "@/db/client";
import { rateLimited } from "@/lib/http";
import { businessDay, businessDayFromInstant } from "@/lib/time";
import {
  CINESTAR_CINEMAS,
  type CineStarCinema,
  EventGoneError,
  fetchEvent,
  fetchHall,
  fetchProgramme,
  normalizeEvent,
  readOccupancy,
} from "@/sources/cinestar";

import { recordSnapshot, resolveFilm, upsertCinema, upsertHall, upsertScreening } from "./repo";
import { nextPollAt } from "./schedule";

/** Minimum gap between requests to api.cinestar.cz. */
const REQUEST_INTERVAL_MS = 350;

/**
 * The programme pages list events far beyond the sales window (opera relays a
 * year out). Registering those wastes an event/get on something nobody can buy
 * yet, so we only take screenings inside this horizon.
 */
const DISCOVERY_HORIZON_DAYS = 45;

export type CsDiscoverResult = {
  slugsFetched: number;
  eventsSeen: number;
  eventsRegistered: number;
  eventsRescheduled: number;
  errors: string[];
};

export async function discoverCineStarSchedule(opts: {
  deadline: number;
}): Promise<CsDiscoverResult> {
  const d = db();
  const result: CsDiscoverResult = {
    slugsFetched: 0,
    eventsSeen: 0,
    eventsRegistered: 0,
    eventsRescheduled: 0,
    errors: [],
  };

  const horizon = Date.now() + DISCOVERY_HORIZON_DAYS * 24 * 60 * 60 * 1000;
  const candidates = new Map<string, { startsAt: Date; cinema: CineStarCinema }>();

  await rateLimited(
    CINESTAR_CINEMAS,
    async (cinema) => {
      const events = await fetchProgramme(cinema.slug);
      result.slugsFetched += 1;
      for (const e of events) {
        result.eventsSeen += 1;
        const t = e.startsAt.getTime();
        if (t < Date.now() || t > horizon) continue;
        candidates.set(e.eventId, { startsAt: e.startsAt, cinema });
      }
    },
    {
      minIntervalMs: REQUEST_INTERVAL_MS,
      deadline: opts.deadline,
      onError: (cinema, err) => result.errors.push(`programme ${cinema.slug}: ${String(err)}`),
    },
  );

  const known = await d
    .select({
      externalId: schema.screenings.externalId,
      startsAt: schema.screenings.startsAt,
    })
    .from(schema.screenings)
    .where(eq(schema.screenings.chain, "cinestar"));
  const knownStarts = new Map(known.map((r) => [r.externalId, r.startsAt]));

  // The programme payload we already have is authoritative about showtimes, so
  // a rescheduled screening can be corrected without spending a request on it.
  for (const [eventId, c] of candidates) {
    const currentStart = knownStarts.get(eventId);
    if (!currentStart || currentStart.getTime() === c.startsAt.getTime()) continue;
    await d
      .update(schema.screenings)
      .set({
        startsAt: c.startsAt,
        screeningDay: businessDayFromInstant(c.startsAt),
        nextPollAt: nextPollAt(c.startsAt, new Date()),
        lastSeenAt: new Date(),
      })
      .where(
        and(eq(schema.screenings.chain, "cinestar"), eq(schema.screenings.externalId, eventId)),
      );
    result.eventsRescheduled += 1;
  }

  const unregistered = [...candidates.keys()].filter((id) => !knownStarts.has(id));
  // Nearest showtime first: those are the ones the poller needs soonest, and a
  // run that hits its deadline resumes here rather than starting over.
  unregistered.sort(
    (a, b) => candidates.get(a)!.startsAt.getTime() - candidates.get(b)!.startsAt.getTime(),
  );

  await rateLimited(
    unregistered,
    async (eventId) => {
      const event = await fetchEvent(eventId);
      await registerScreening(d, event, candidates.get(eventId)!.cinema);
      result.eventsRegistered += 1;
    },
    {
      minIntervalMs: REQUEST_INTERVAL_MS,
      deadline: opts.deadline,
      onError: (eventId, err) => {
        if (err instanceof EventGoneError) return; // already sold out of the window
        result.errors.push(`event ${eventId}: ${String(err)}`);
      },
    },
  );

  return result;
}

async function registerScreening(
  d: ReturnType<typeof db>,
  event: Awaited<ReturnType<typeof fetchEvent>>,
  cinema: CineStarCinema,
): Promise<void> {
  const n = normalizeEvent(event);

  const cinemaId = await upsertCinema(d, {
    chain: n.chain,
    // Keyed on the numeric cinemaid from the event, named from the programme
    // page it came from — the event payload itself carries no cinema name.
    externalId: n.cinema.externalId,
    name: cinema.name,
    city: cinema.city,
  });

  const hall = await upsertHall(d, {
    cinemaId,
    externalId: n.hall.externalId,
    name: n.hall.name,
  });

  const filmId = await resolveFilm(d, {
    chain: n.chain,
    externalId: n.film.externalId,
    title: n.film.title,
    originalTitle: n.film.originalTitle,
  });

  await upsertScreening(d, {
    chain: n.chain,
    externalId: n.externalId,
    filmId,
    hallId: hall.id,
    startsAt: n.startsAt,
    screeningDay: businessDay(event.start),
    capacity: hall.capacity,
    formatAttrs: n.formatAttrs,
    languageVersion: n.languageVersion,
    soldOut: false,
    // Poll straight away so a newly listed screening gets a baseline snapshot.
    nextPollAt: new Date(),
  });
}

export type CsPollResult = {
  polled: number;
  gone: number;
  errors: string[];
};

export async function pollCineStarHalls(opts: {
  deadline: number;
  batchSize?: number;
}): Promise<CsPollResult> {
  const d = db();
  const result: CsPollResult = { polled: 0, gone: 0, errors: [] };
  const now = new Date();

  const due = await d
    .select({
      id: schema.screenings.id,
      externalId: schema.screenings.externalId,
      startsAt: schema.screenings.startsAt,
    })
    .from(schema.screenings)
    .where(
      and(
        eq(schema.screenings.chain, "cinestar"),
        // A null `nextPollAt` means the screening has left the queue: either it
        // already ran, or sales closed and the settle job now owns it.
        isNotNull(schema.screenings.nextPollAt),
        lte(schema.screenings.nextPollAt, now),
      ),
    )
    .orderBy(asc(schema.screenings.startsAt))
    .limit(opts.batchSize ?? 400);

  await rateLimited(
    due,
    async (row) => {
      try {
        const hall = await fetchHall(row.externalId);
        const occ = readOccupancy(hall);
        await recordSnapshot(d, {
          screeningId: row.id,
          seatsSold: occ.seatsSold,
          seatsTotal: occ.seatsTotal,
          priceMin: occ.priceMin,
          priceMax: occ.priceMax,
          priceSource: occ.priceMin != null ? "chain" : null,
          nextPollAt: nextPollAt(row.startsAt, new Date()),
        });
        result.polled += 1;
      } catch (err) {
        if (err instanceof EventGoneError) {
          // Sales are closed. Take it out of the queue and let settle decide
          // the final figure from whatever snapshots we already have.
          await d
            .update(schema.screenings)
            .set({ nextPollAt: null, lastPolledAt: new Date() })
            .where(eq(schema.screenings.id, row.id));
          result.gone += 1;
          return;
        }
        throw err;
      }
    },
    {
      minIntervalMs: REQUEST_INTERVAL_MS,
      deadline: opts.deadline,
      onError: (row, err) => result.errors.push(`hall ${row.externalId}: ${String(err)}`),
    },
  );

  return result;
}
