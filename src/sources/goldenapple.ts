/**
 * Golden Apple Cinema, Zlín.
 *
 * Two venues under one operator — the six-screen multiplex on nám. Míru and the
 * single-screen Malé kino in Kudlov — running Datakal ticketing behind an
 * Umbraco site.
 *
 * The shape is unusually friendly. The home page renders four days of the whole
 * programme server-side, so one request gives every screening, its hall, its
 * language version and its Datakal id; the seat plan then costs one POST per
 * screening and comes back as SVG with a `<g>` per seat. That is the same
 * per-screening cost as CineStar, over a tenth of the volume.
 *
 * There is no robots.txt on gacinema.cz, so nothing here is excluded — unlike
 * Premiere Cinemas, whose `/vstupenky/` booking area is disallowed, and CINEMAX,
 * whose ticketing host disallows everything. Both of those are deliberate
 * exclusions and are left alone.
 */

import { fetchText } from "@/lib/http";
import { pragueToUtc } from "@/lib/time";

const BASE = "https://www.gacinema.cz";

export type GaScreening = {
  /** Datakal screening id, the argument to `getScreening(...)`. */
  screeningId: string;
  /** `YYYY-MM-DD` as printed on the day tab. */
  day: string;
  /** `HH:MM` in Prague time. */
  time: string;
  startsAt: Date;
  /** "Multikino" or "Malé kino" — separate addresses, separate venues. */
  venue: string;
  /** "Sál 4"; for Malé kino the hall and the venue share a name. */
  hall: string;
  film: { externalId: string; title: string };
  /** `DAB` / `TIT` / `ORIG` as the site labels them. */
  version: string | null;
  /** Technologies from the showtime tooltip, e.g. `4K`. */
  attributes: string[];
};

const decode = (s: string): string =>
  s
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

const strip = (html: string): string => decode(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();

/** `02.08.2026` → `2026-08-02`. */
function isoDay(printed: string): string | null {
  const m = printed.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

/**
 * Read the four-day programme out of the home page.
 *
 * The page is one `tab-item` per day in the same order as the day tabs, and
 * inside each day a `cinema-name` heading opens a venue's block. Both are
 * matched positionally against the source text rather than parsed into a DOM —
 * the project has no DOM dependency, and the markup is machine-generated and
 * stable enough that a scan is honest here.
 */
export function parseProgramme(html: string): GaScreening[] {
  const days = [...html.matchAll(/big-date-a">(\d{2}\.\d{2}\.\d{4})</g)]
    .map((m) => isoDay(m[1]))
    .filter((d): d is string => d !== null);
  if (days.length === 0) return [];

  const tabs = [...html.matchAll(/<div Class=['"]tab-item[^>]*>/gi)].map((m) => m.index!);
  if (tabs.length === 0) return [];

  const screenings: GaScreening[] = [];

  for (let t = 0; t < tabs.length; t++) {
    const day = days[t];
    // More day tabs than rendered days happens near the end of the window;
    // a block we cannot date is a block we cannot use.
    if (!day) continue;
    const block = html.slice(tabs[t], tabs[t + 1] ?? html.length);

    // A day can hold several venues, each introduced by its own heading.
    const venues = [...block.matchAll(/cinema-name">([^<]*)</g)];
    for (let v = 0; v < venues.length; v++) {
      const venue = strip(venues[v][1]);
      const from = venues[v].index!;
      const to = venues[v + 1]?.index ?? block.length;
      for (const item of block.slice(from, to).matchAll(/<li>([\s\S]*?)<\/li>/g)) {
        screenings.push(...parseItem(item[1], day, venue));
      }
    }
  }

  return screenings;
}

/**
 * One row can hold several showtimes.
 *
 * The same film in the same hall on the same day is rendered as one `<li>` with
 * a `.item` per start time, so a row yields as many screenings as it has times
 * — taking only the first silently loses a fifth of the programme.
 */
function parseItem(item: string, day: string, venue: string): GaScreening[] {
  const film = item.match(/href='\/filmy\/detail\/\?id=(\d+)'[^>]*>([\s\S]*?)<\/a>/);
  if (!film) return [];

  // The film link wraps a nested `other-val` label ("anime", "filmový klub") —
  // that is a programme strand, not part of the title.
  const title = strip(film[2].replace(/<div class='other-val'>[\s\S]*?<\/div>/g, ""));
  if (!title) return [];

  const hallHtml = item.match(/<div Class='location-icon'>([\s\S]*?)<\/div>/);
  const version = item.match(/font-size: 0\.8em;'>([^<]*)</);

  const shows = item.matchAll(
    /<div class="item"[^>]*title="([^"]*)"[^>]*onclick="getScreening\((\d+),[^"]*"\s*>(\d{1,2}:\d{2})</g,
  );

  const out: GaScreening[] = [];
  for (const [, tooltip, screeningId, printedTime] of shows) {
    const time = printedTime.padStart(5, "0");
    out.push({
      screeningId,
      day,
      time,
      startsAt: pragueToUtc(`${day} ${time}`),
      venue,
      hall: hallHtml ? strip(hallHtml[1]) : venue,
      film: { externalId: film[1], title },
      version: version ? strip(version[1]) || null : null,
      attributes: strip(tooltip)
        .split(",")
        .map((p) => p.trim())
        // The tooltip is "4K, 90 minut"; the runtime is not an attribute.
        .filter((p) => p && !/minut/i.test(p)),
    });
  }
  return out;
}

export async function fetchProgramme(): Promise<GaScreening[]> {
  return parseProgramme(await fetchText(`${BASE}/`, { timeoutMs: 30_000 }));
}

export type GaOccupancy = {
  seatsSold: number;
  seatsTotal: number;
  priceMin: number | null;
  priceMax: number | null;
  /** False when no seat is on sale — a closed screening, not a full one. */
  sellable: boolean;
};

/**
 * Count seats in a seat-plan response.
 *
 * `seat-item occupied` covers sold seats and seats the cinema has blocked;
 * Datakal labels both "Nedostupné" and does not distinguish them, exactly as
 * CineStar's OCCUPIED does not. Both are counted as taken, which is the
 * conservative reading — an unsold blocked seat was never going to be sold.
 *
 * The one case that is *not* a reading is a plan where every seat is
 * unavailable. That is what Datakal returns once sales close, so a 10:00
 * screening read at 13:00 comes back as a full house — measured, seven of our
 * screenings were sitting at exactly 100% and every one of them had already
 * started. `sellable` lets the caller tell the two apart.
 */
export function readOccupancy(html: string): GaOccupancy {
  const seats = [...html.matchAll(/<g class="seat-item([^"]*)"([\s\S]*?)<\/g>/g)];
  const prices: number[] = [];
  let sold = 0;

  for (const [, classes, body] of seats) {
    if (/\boccupied\b/.test(classes)) {
      sold += 1;
      continue;
    }
    const price = body.match(/Cena:\s*([\d\s ]+(?:,\d+)?)/);
    if (price) {
      const value = Number(price[1].replace(/[\s ]/g, "").replace(",", "."));
      if (Number.isFinite(value) && value > 0) prices.push(value);
    }
  }

  return {
    seatsSold: sold,
    seatsTotal: seats.length,
    priceMin: prices.length ? Math.min(...prices) : null,
    priceMax: prices.length ? Math.max(...prices) : null,
    sellable: seats.length > 0 && sold < seats.length,
  };
}

/** Thrown when a screening is no longer on sale, so the caller can stop polling. */
export class ScreeningGoneError extends Error {
  constructor(readonly screeningId: string) {
    super(`Golden Apple screening ${screeningId} is no longer on sale`);
    this.name = "ScreeningGoneError";
  }
}

export async function fetchSeating(screeningId: string): Promise<GaOccupancy> {
  const html = await fetchText(`${BASE}/umbraco/Surface/ticketinglocal/GetSeating`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-requested-with": "XMLHttpRequest",
    },
    body: new URLSearchParams({ id: screeningId }).toString(),
    timeoutMs: 30_000,
  });

  const occupancy = readOccupancy(html);
  // A response with no plan at all is unambiguous: sales are over. The
  // every-seat-greyed-out case is not — it looks identical to a real sell-out —
  // so it is left to the caller, which knows whether the screening has started.
  if (occupancy.seatsTotal === 0) throw new ScreeningGoneError(screeningId);
  return occupancy;
}
