/**
 * Golden Apple ingest.
 *
 * Same two halves as CineStar — discover the schedule, then work a due queue of
 * seat plans — but discovery is a single page load rather than twelve, and it
 * carries the film titles with it, so nothing has to be looked up per screening.
 *
 * The whole operator is about ninety screenings across four days, which is under
 * three per cent of what Cinema City alone contributes. It is here because Zlín
 * is otherwise a blank spot on the map, not because it moves the totals.
 */

import { nextPollAt } from "@/core/schedule";
import { rateLimited } from "@/lib/http";
import { businessDayFromInstant } from "@/lib/time";
import { normalizeFormats } from "@/sources/formats";
import {
  fetchProgramme,
  fetchSeating,
  type GaScreening,
  ScreeningGoneError,
} from "@/sources/goldenapple";
import { recordReading, resolveFilm, upsertCinema, upsertHall, upsertScreening } from "@/store/mutations";
import { key, type State } from "@/store/types";

const REQUEST_INTERVAL_MS = 400;

/**
 * How full a screening must already have been for a jump to 100% to be real.
 *
 * A hall does not go from a tenth sold to sold out inside one poll interval;
 * what does happen in one step is online sales closing, which greys out every
 * seat at once. Below this the full house is read as the shutter, not a crowd.
 */
const SELLOUT_APPROACH = 0.8;

/** How long before a screening online sales can already have closed. */
const CLOSING_WINDOW_MS = 60 * 60_000;

export type GaIngestResult = {
  seen: number;
  registered: number;
  rescheduled: number;
  polled: number;
  gone: number;
  repaired: number;
  errors: string[];
};

/**
 * Throw away readings taken after a screening had already started.
 *
 * Datakal answers a closed screening with every seat greyed out, so a 10:00
 * show read at 13:00 comes back as a full house. Seven screenings were sitting
 * at exactly 100% when this was found, all of them already played, and in ten
 * days settle would have folded those invented sell-outs into history where
 * nothing can correct them.
 *
 * A reading captured after showtime cannot be salvaged — whatever genuine
 * figure preceded it has been overwritten — so the screening goes back to
 * unmeasured and settles as `missed`, which is what actually happened.
 */
export function repairClosedReadings(state: State, now: Date = new Date()): number {
  let repaired = 0;
  for (const s of Object.values(state.screenings)) {
    if (s.chain !== "golden_apple" || s.sold === null || s.total === null) continue;
    if (s.sold < s.total) continue;
    const startedAt = new Date(s.startsAt).getTime();
    // A screening still comfortably in the future at 100% is a real sell-out
    // and must survive this. Sales close before the show rather than at it, so
    // the hour before showtime is inside the suspect window too.
    if (startedAt - CLOSING_WINDOW_MS > now.getTime()) continue;
    if (s.at !== null && new Date(s.at).getTime() < startedAt - CLOSING_WINDOW_MS) continue;

    s.sold = null;
    s.total = null;
    s.at = null;
    s.nextPollAt = null;
    if (s.settled) s.settled = { sold: 0, total: 0, confidence: "missed", capturedAt: null };
    repaired += 1;
  }
  return repaired;
}

export async function ingestGoldenApple(
  state: State,
  opts: { deadline: number; batchSize?: number },
): Promise<GaIngestResult> {
  const result: GaIngestResult = {
    seen: 0,
    registered: 0,
    rescheduled: 0,
    polled: 0,
    gone: 0,
    repaired: 0,
    errors: [],
  };

  result.repaired = repairClosedReadings(state);

  try {
    const programme = await fetchProgramme();
    result.seen = programme.length;
    for (const screening of programme) register(state, screening, result);
  } catch (err) {
    // A failed programme fetch still leaves a queue from previous runs worth
    // polling, so this is reported rather than thrown.
    result.errors.push(`programme: ${String(err)}`);
  }

  const now = Date.now();
  const due: [string, (typeof state.screenings)[string]][] = [];
  for (const entry of Object.entries(state.screenings)) {
    const s = entry[1];
    if (s.chain !== "golden_apple" || s.nextPollAt === null) continue;
    // A screening that has started is not readable any more: Datakal answers
    // with every seat greyed out, which reads as a sell-out. Drop it from the
    // queue rather than take that reading.
    if (new Date(s.startsAt).getTime() <= now) {
      s.nextPollAt = null;
      result.gone += 1;
      continue;
    }
    if (new Date(s.nextPollAt).getTime() <= now) due.push(entry);
  }
  // Soonest showtime first — those are the readings that cannot be retaken.
  due.sort((a, b) => a[1].startsAt.localeCompare(b[1].startsAt));
  due.splice(opts.batchSize ?? 120);

  await rateLimited(
    due,
    async ([k, screening]) => {
      const externalId = k.slice("golden_apple:".length);
      try {
        const occ = await fetchSeating(externalId);
        // Online sales shut before the film starts, not at it, so the
        // every-seat-greyed-out answer arrives while the screening is still in
        // the future — one 09:00 show was recorded at 95/95 that way. A real
        // sell-out is approached, not jumped to: if the previous reading was
        // nowhere near full, the hall did not fill in one poll interval, the
        // shutter came down.
        if (!occ.sellable && (screening.sold ?? 0) < occ.seatsTotal * SELLOUT_APPROACH) {
          screening.nextPollAt = null;
          result.gone += 1;
          return;
        }
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
        if (err instanceof ScreeningGoneError) {
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
      onError: ([k], err) => result.errors.push(`seating ${k}: ${String(err)}`),
    },
  );

  return result;
}

function register(state: State, s: GaScreening, result: GaIngestResult): void {
  const existing = state.screenings[key("golden_apple", s.screeningId)];
  if (existing) {
    if (new Date(existing.startsAt).getTime() !== s.startsAt.getTime()) {
      existing.startsAt = s.startsAt.toISOString();
      existing.day = businessDayFromInstant(s.startsAt);
      existing.nextPollAt = nextPollAt(s.startsAt, new Date())?.toISOString() ?? null;
      result.rescheduled += 1;
    }
    return;
  }

  const cinemaKey = upsertCinema(state, {
    chain: "golden_apple",
    // The two venues have different addresses and different programmes, so they
    // are two cinemas even though one operator runs both.
    externalId: s.venue,
    name: s.venue === "Multikino" ? "Golden Apple Zlín" : `Golden Apple ${s.venue}`,
    city: "Zlín",
  });

  const hallKey = upsertHall(state, {
    chain: "golden_apple",
    externalId: `${s.venue}/${s.hall}`,
    cinemaKey,
    name: s.hall,
  });

  const filmId = resolveFilm(state, {
    chain: "golden_apple",
    externalId: s.film.externalId,
    title: s.film.title,
    // The site publishes only the Czech distribution title; matching to the
    // other chains happens on that, which is what the UFD tables use too.
    originalTitle: null,
  });

  upsertScreening(state, {
    chain: "golden_apple",
    externalId: s.screeningId,
    filmId,
    hallKey,
    startsAt: s.startsAt,
    day: businessDayFromInstant(s.startsAt),
    formats: normalizeFormats(s.attributes),
    lang: languageVersion(s.version),
    soldOut: false,
    // Poll straight away so a newly listed screening gets its baseline. The
    // programme page still lists today's morning shows in the afternoon, and
    // those are unreadable — queueing one buys a fabricated sell-out, not a
    // reading.
    nextPollAt: s.startsAt.getTime() > Date.now() ? new Date() : null,
  });

  result.registered += 1;
}

/** The site's own three-letter labels, in the wording the dashboard already uses. */
function languageVersion(version: string | null): string | null {
  if (!version) return null;
  const v = version.toUpperCase();
  if (v === "DAB") return "dabing";
  if (v === "TIT") return "titulky";
  // "ORIG" means a Czech film played in its own language, which is neither.
  return null;
}
