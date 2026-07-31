/**
 * Cinema City (13 multiplexes in CZ).
 *
 * The whole chain fits in one anonymous request: `/api/presentations/` returns
 * every screening for the next ~30 days, each carrying an `availRatio`. That
 * ratio is not a coarse bucket — multiplied by the hall capacity it lands on
 * whole seats, so it yields the exact number of tickets sold. Capacity itself
 * comes from a separate seatplan call, which is cheap because it is a property
 * of the hall rather than the screening and can be cached indefinitely.
 */

import { fetchJson } from "@/lib/http";
import { businessDay, pragueToUtc } from "@/lib/time";

import { normalizeFormats } from "./formats";

const BASE = "https://tickets.cinemacity.cz/api";

/** Only the fields we actually consume; the real payload has many more. */
export type CcPresentation = {
  id: number;
  dateTime: string;
  businessDate: string;
  featureName: string;
  featureAdditionalName: string | null;
  featureId: number;
  durationInMinutes: number;
  venueId: number;
  venueName: string;
  seatplanId: number;
  venueCity: string | null;
  venueLocationId: number;
  locationName: string;
  /** Fraction of seats still free. */
  availRatio: number;
  soldout: number;
  featureAttributes: string[] | null;
  dubbedLanguageISO: string | null;
  subbedLanguageISO: string | null;
};

type CcSeatplan = {
  sections: Record<string, { Capacity: number }>;
};

export async function fetchPresentations(): Promise<CcPresentation[]> {
  const body = await fetchJson<{ presentations: CcPresentation[] }>(`${BASE}/presentations/`, {
    // The feed is ~5 MB and the origin is occasionally slow under load.
    timeoutMs: 60_000,
    headers: { referer: "https://tickets.cinemacity.cz/" },
  });
  return body.presentations ?? [];
}

export async function fetchHallCapacity(seatplanId: number, venueId: number): Promise<number> {
  const plan = await fetchJson<CcSeatplan>(
    `${BASE}/seats/seatplan?seatplanId=${seatplanId}&venueId=${venueId}`,
    { headers: { referer: "https://tickets.cinemacity.cz/" } },
  );
  return Object.values(plan.sections ?? {}).reduce((sum, s) => sum + (s.Capacity ?? 0), 0);
}

/**
 * Turn the availability ratio into a seat count.
 *
 * The ratio is reported to four decimals, so `capacity * ratio` lands within a
 * hundredth of an integer. Rounding is therefore exact rather than approximate,
 * but a ratio that misses an integer by a wide margin means our cached capacity
 * is stale (the hall was re-seated), and the caller needs to know.
 */
export function seatsSoldFromRatio(
  capacity: number,
  availRatio: number,
): { seatsSold: number; residual: number } {
  const free = capacity * availRatio;
  const rounded = Math.round(free);
  return {
    seatsSold: Math.max(0, Math.min(capacity, capacity - rounded)),
    residual: Math.abs(free - rounded),
  };
}

/** Above this the capacity no longer explains the ratio and should be refetched. */
export const CAPACITY_RESIDUAL_TOLERANCE = 0.05;

export type NormalizedCcScreening = {
  chain: "cinema_city";
  externalId: string;
  startsAt: Date;
  screeningDay: string;
  cinema: { externalId: string; name: string; city: string | null };
  hall: { externalId: string; name: string; seatplanExternalId: string };
  film: { externalId: string; title: string; originalTitle: string | null };
  formatAttrs: string[];
  languageVersion: string | null;
  soldOut: boolean;
  availRatio: number;
};

export function normalize(p: CcPresentation): NormalizedCcScreening {
  return {
    chain: "cinema_city",
    externalId: String(p.id),
    startsAt: pragueToUtc(p.dateTime),
    // The chain publishes its own businessDate; we prefer it over deriving one
    // so that our per-day totals line up with how the cinema itself counts.
    screeningDay: p.businessDate || businessDay(p.dateTime),
    cinema: {
      externalId: String(p.venueLocationId),
      // The feed says "Chodov"; the dashboard sits next to CineStar rows, so
      // the chain has to be part of the name.
      name: `Cinema City ${p.locationName}`,
      city: p.venueCity,
    },
    hall: {
      externalId: String(p.venueId),
      name: p.venueName,
      seatplanExternalId: String(p.seatplanId),
    },
    film: {
      externalId: String(p.featureId),
      title: p.featureName,
      originalTitle: p.featureAdditionalName || null,
    },
    formatAttrs: normalizeFormats(p.featureAttributes),
    languageVersion: p.dubbedLanguageISO === "cs" ? "dabing" : p.subbedLanguageISO ? "titulky" : null,
    soldOut: p.soldout === 1,
    availRatio: p.availRatio,
  };
}
