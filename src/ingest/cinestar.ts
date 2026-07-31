/**
 * CineStar ingest, in two halves.
 *
 * `discoverCineStarSchedule` walks the 12 programme pages and registers new
 * screenings, paying one `event/get` for each one it has never seen. Metadata
 * does not change, so that cost is paid once per screening rather than per poll.
 *
 * `pollCineStarHalls` works a due-queue of `hall/get` calls until its time
 * budget runs out. It never tries to drain the queue — stopping cleanly
 * mid-queue and resuming next run is the whole point of `nextPollAt`.
 */

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
import { recordReading, resolveFilm, upsertCinema, upsertHall, upsertScreening } from "@/store/mutations";
import { key, type State } from "@/store/types";

import { nextPollAt } from "@/core/schedule";

/** Minimum gap between requests to api.cinestar.cz. */
const REQUEST_INTERVAL_MS = 350;

/**
 * Programme pages list events far beyond the sales window — opera relays a year
 * out. Registering those spends an `event/get` on something nobody can buy yet.
 */
const DISCOVERY_HORIZON_DAYS = 45;

export type CsDiscoverResult = {
  pagesFetched: number;
  eventsSeen: number;
  registered: number;
  rescheduled: number;
  errors: string[];
};

export async function discoverCineStarSchedule(
  state: State,
  opts: { deadline: number },
): Promise<CsDiscoverResult> {
  const result: CsDiscoverResult = {
    pagesFetched: 0,
    eventsSeen: 0,
    registered: 0,
    rescheduled: 0,
    errors: [],
  };

  const horizon = Date.now() + DISCOVERY_HORIZON_DAYS * 24 * 60 * 60 * 1000;
  const candidates = new Map<string, { startsAt: Date; cinema: CineStarCinema }>();

  await rateLimited(
    CINESTAR_CINEMAS,
    async (cinema) => {
      const events = await fetchProgramme(cinema.slug);
      result.pagesFetched += 1;
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

  const unregistered: string[] = [];
  for (const [eventId, c] of candidates) {
    const existing = state.screenings[key("cinestar", eventId)];
    if (!existing) {
      unregistered.push(eventId);
      continue;
    }
    // The programme payload is authoritative about showtimes and we already
    // have it, so a rescheduled screening is corrected for free.
    if (new Date(existing.startsAt).getTime() !== c.startsAt.getTime()) {
      existing.startsAt = c.startsAt.toISOString();
      existing.day = businessDayFromInstant(c.startsAt);
      existing.nextPollAt = nextPollAt(c.startsAt, new Date())?.toISOString() ?? null;
      result.rescheduled += 1;
    }
  }

  // Nearest showtime first: a run that hits its deadline resumes here rather
  // than starting over, so the most urgent screenings are always registered.
  unregistered.sort(
    (a, b) => candidates.get(a)!.startsAt.getTime() - candidates.get(b)!.startsAt.getTime(),
  );

  await rateLimited(
    unregistered,
    async (eventId) => {
      const event = await fetchEvent(eventId);
      registerScreening(state, event, candidates.get(eventId)!.cinema);
      result.registered += 1;
    },
    {
      minIntervalMs: REQUEST_INTERVAL_MS,
      deadline: opts.deadline,
      onError: (eventId, err) => {
        if (err instanceof EventGoneError) return; // already out of the sales window
        result.errors.push(`event ${eventId}: ${String(err)}`);
      },
    },
  );

  return result;
}

function registerScreening(
  state: State,
  event: Awaited<ReturnType<typeof fetchEvent>>,
  cinema: CineStarCinema,
): void {
  const n = normalizeEvent(event);

  const cinemaKey = upsertCinema(state, {
    chain: n.chain,
    // Keyed on the numeric cinemaid from the event, named from the programme
    // page it came from — the event payload carries no cinema name.
    externalId: n.cinema.externalId,
    name: cinema.name,
    city: cinema.city,
  });

  const hallKey = upsertHall(state, {
    chain: n.chain,
    externalId: n.hall.externalId,
    cinemaKey,
    name: n.hall.name,
  });

  const filmId = resolveFilm(state, {
    chain: n.chain,
    externalId: n.film.externalId,
    title: n.film.title,
    originalTitle: n.film.originalTitle,
  });

  upsertScreening(state, {
    chain: n.chain,
    externalId: n.externalId,
    filmId,
    hallKey,
    startsAt: n.startsAt,
    day: businessDay(event.start),
    formats: n.formatAttrs,
    lang: n.languageVersion,
    soldOut: false,
    // Poll straight away so a newly listed screening gets its baseline.
    nextPollAt: new Date(),
  });
}

export type CsPollResult = {
  polled: number;
  gone: number;
  queued: number;
  errors: string[];
};

export async function pollCineStarHalls(
  state: State,
  opts: { deadline: number; batchSize?: number },
): Promise<CsPollResult> {
  const result: CsPollResult = { polled: 0, gone: 0, queued: 0, errors: [] };
  const now = Date.now();

  const due = Object.entries(state.screenings)
    .filter(([, s]) => s.chain === "cinestar" && s.nextPollAt !== null)
    .filter(([, s]) => new Date(s.nextPollAt!).getTime() <= now)
    // Soonest showtime first — those are the readings we cannot retake.
    .sort((a, b) => a[1].startsAt.localeCompare(b[1].startsAt))
    .slice(0, opts.batchSize ?? 400);

  result.queued = due.length;

  await rateLimited(
    due,
    async ([k, screening]) => {
      const externalId = k.slice("cinestar:".length);
      try {
        const hall = await fetchHall(externalId);
        const occ = readOccupancy(hall);
        recordReading(state, screening, {
          sold: occ.seatsSold,
          total: occ.seatsTotal,
          priceMin: occ.priceMin,
          priceMax: occ.priceMax,
        });
        screening.nextPollAt =
          nextPollAt(new Date(screening.startsAt), new Date())?.toISOString() ?? null;
        result.polled += 1;
      } catch (err) {
        if (err instanceof EventGoneError) {
          // Sales are closed. Leave the queue and let settle decide the final
          // figure from whatever we already captured.
          screening.nextPollAt = null;
          result.gone += 1;
          return;
        }
        throw err;
      }
    },
    {
      minIntervalMs: REQUEST_INTERVAL_MS,
      deadline: opts.deadline,
      onError: ([k], err) => result.errors.push(`hall ${k}: ${String(err)}`),
    },
  );

  return result;
}
