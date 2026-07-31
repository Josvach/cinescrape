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
import { businessDayFromInstant } from "@/lib/time";
import { normalizeFormats } from "@/sources/formats";
import {
  CINESTAR_CINEMAS,
  type CineStarCinema,
  EventGoneError,
  fetchEvent,
  fetchHall,
  fetchProgramme,
  normalizeEvent,
  readOccupancy,
  type ScheduledEvent,
  versionFromProperties,
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
  titlesLookedUp: number;
  titlesUnresolved: number;
  errors: string[];
};

type Candidate = {
  event: ScheduledEvent;
  cinema: CineStarCinema;
  /** `cinemaid` from the hall records on the same page. */
  cinemaId: string;
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
    titlesLookedUp: 0,
    titlesUnresolved: 0,
    errors: [],
  };

  const horizon = Date.now() + DISCOVERY_HORIZON_DAYS * 24 * 60 * 60 * 1000;
  const candidates = new Map<string, Candidate>();

  await rateLimited(
    CINESTAR_CINEMAS,
    async (cinema) => {
      const programme = await fetchProgramme(cinema.slug);
      result.pagesFetched += 1;
      for (const event of programme.events) {
        result.eventsSeen += 1;
        const t = event.startsAt.getTime();
        if (t < Date.now() || t > horizon) continue;
        const cinemaId = programme.hallCinemas[event.objectId];
        // Without the hall→cinema mapping we cannot place the screening, and
        // guessing would attribute it to the wrong multiplex.
        if (!cinemaId) continue;
        candidates.set(event.eventId, { event, cinema, cinemaId });
      }
    },
    {
      minIntervalMs: REQUEST_INTERVAL_MS,
      deadline: opts.deadline,
      onError: (cinema, err) => result.errors.push(`programme ${cinema.slug}: ${String(err)}`),
    },
  );

  const unregistered: Candidate[] = [];
  for (const [eventId, c] of candidates) {
    const existing = state.screenings[key("cinestar", eventId)];
    if (!existing) {
      unregistered.push(c);
      continue;
    }
    // The programme payload is authoritative about showtimes and we already
    // have it, so a rescheduled screening is corrected for free.
    if (new Date(existing.startsAt).getTime() !== c.event.startsAt.getTime()) {
      existing.startsAt = c.event.startsAt.toISOString();
      existing.day = businessDayFromInstant(c.event.startsAt);
      existing.nextPollAt = nextPollAt(c.event.startsAt, new Date())?.toISOString() ?? null;
      result.rescheduled += 1;
    }
  }

  // Nearest showtime first, so a run that runs out of budget has still named
  // the films playing tonight.
  unregistered.sort((a, b) => a.event.startsAt.getTime() - b.event.startsAt.getTime());

  // The programme pages carry everything except the film's name, so the only
  // per-request work left is naming each unknown TitleId — once, not once per
  // screening. Across all twelve cinemas that is dozens of lookups rather than
  // thousands, which is what lets a single run register the whole schedule.
  const unknownTitles: string[] = [];
  for (const c of unregistered) {
    const id = c.event.titleId;
    if (id && state.cineStarTitles[id] === undefined && !unknownTitles.includes(id)) {
      unknownTitles.push(id);
    }
  }

  await rateLimited(
    unknownTitles,
    async (titleId) => {
      const sample = unregistered.find((c) => c.event.titleId === titleId)!;
      const event = await fetchEvent(sample.event.eventId);
      const n = normalizeEvent(event);
      state.cineStarTitles[titleId] = resolveFilm(state, {
        chain: "cinestar",
        externalId: n.film.externalId,
        title: n.film.title,
        originalTitle: n.film.originalTitle,
      });
      // One lookup also happens to name one hall; the rest stay unnamed, which
      // only affects a label.
      learnHallName(state, sample, n.hall.externalId, n.hall.name);
      result.titlesLookedUp += 1;
    },
    {
      minIntervalMs: REQUEST_INTERVAL_MS,
      deadline: opts.deadline,
      onError: (titleId, err) => {
        // A sold-out or withdrawn sample event is not worth a loud failure;
        // the next run picks another screening of the same film.
        if (err instanceof EventGoneError) return;
        result.errors.push(`title ${titleId}: ${String(err)}`);
      },
    },
  );

  for (const c of unregistered) {
    const filmId = state.cineStarTitles[c.event.titleId];
    if (filmId === undefined) {
      // Its title lookup did not happen this run — try again on the next one
      // rather than registering a screening we cannot name.
      result.titlesUnresolved += 1;
      continue;
    }
    registerScreening(state, c, filmId);
    result.registered += 1;
  }

  return result;
}

function hallKeyFor(state: State, c: Candidate, hallExternalId: string): string {
  const cinemaKey = upsertCinema(state, {
    chain: "cinestar",
    // Keyed on the numeric cinemaid the programme page publishes, named from
    // the page it came from — neither payload carries a cinema name.
    externalId: c.cinemaId,
    name: c.cinema.name,
    city: c.cinema.city,
  });
  return upsertHall(state, {
    chain: "cinestar",
    externalId: hallExternalId,
    cinemaKey,
  });
}

function learnHallName(state: State, c: Candidate, hallExternalId: string, name: string): void {
  const k = hallKeyFor(state, c, hallExternalId);
  const hall = state.halls[k];
  if (hall) hall.name = name;
}

function registerScreening(state: State, c: Candidate, filmId: number): void {
  const hallKey = hallKeyFor(state, c, c.event.objectId);

  upsertScreening(state, {
    chain: "cinestar",
    externalId: c.event.eventId,
    filmId,
    hallKey,
    startsAt: c.event.startsAt,
    day: businessDayFromInstant(c.event.startsAt),
    formats: normalizeFormats(c.event.properties),
    lang: versionFromProperties(c.event.properties),
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
