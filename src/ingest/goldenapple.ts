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

export type GaIngestResult = {
  seen: number;
  registered: number;
  rescheduled: number;
  polled: number;
  gone: number;
  errors: string[];
};

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
    errors: [],
  };

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
  const due = Object.entries(state.screenings)
    .filter(([, s]) => s.chain === "golden_apple" && s.nextPollAt !== null)
    .filter(([, s]) => new Date(s.nextPollAt!).getTime() <= now)
    // Soonest showtime first — those are the readings that cannot be retaken.
    .sort((a, b) => a[1].startsAt.localeCompare(b[1].startsAt))
    .slice(0, opts.batchSize ?? 120);

  await rateLimited(
    due,
    async ([k, screening]) => {
      const externalId = k.slice("golden_apple:".length);
      try {
        const occ = await fetchSeating(externalId);
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
    // Poll straight away so a newly listed screening gets its baseline.
    nextPollAt: new Date(),
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
