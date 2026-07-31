/**
 * CineStar (13 multiplexes in CZ).
 *
 * Unlike Cinema City there is no chain-wide feed. The schedule comes from the
 * server-rendered payload of each cinema's programme page, and occupancy has to
 * be asked for one screening at a time via `/api/hall/get`, which returns the
 * seating plan seat by seat. That is more expensive but also richer: we get the
 * exact occupied count and the real price list rather than a ratio.
 */

import { fetchJson, fetchText } from "@/lib/http";
import { pragueToUtc } from "@/lib/time";

import { normalizeFormats } from "./formats";

const API = "https://api.cinestar.cz";
const WEB = "https://cinestar.cz";
const ORIGIN = "https://websale.cinestar.cz";

/**
 * Cinema programme pages, taken from the sitemap entries the site's own bundle
 * declares. The event payload carries a numeric `cinemaid` but no name, so the
 * display name is carried alongside the slug that produced the event.
 *
 * The bundle also lists a `budejoviceIgy` slug; it 404s and the twelve slugs
 * below yield a contiguous cinemaid range of 1..12, so that entry is stale
 * rather than a cinema we are missing.
 *
 * Screening identity still comes from `cinemaid`, not from the slug, so a slug
 * that starts redirecting elsewhere produces duplicates that dedupe on event id
 * rather than corrupting anything.
 */
export const CINESTAR_CINEMAS = [
  { slug: "boleslav", name: "CineStar Mladá Boleslav", city: "Mladá Boleslav" },
  { slug: "budejovice", name: "CineStar České Budějovice", city: "České Budějovice" },
  { slug: "hradec", name: "CineStar Hradec Králové", city: "Hradec Králové" },
  { slug: "jihlava", name: "CineStar Jihlava", city: "Jihlava" },
  { slug: "liberec", name: "CineStar Liberec", city: "Liberec" },
  { slug: "olomouc", name: "CineStar Olomouc", city: "Olomouc" },
  { slug: "opava", name: "CineStar Opava", city: "Opava" },
  { slug: "ostrava", name: "CineStar Ostrava", city: "Ostrava" },
  { slug: "pardubice", name: "CineStar Pardubice", city: "Pardubice" },
  { slug: "plzen", name: "CineStar Plzeň", city: "Plzeň" },
  { slug: "praha5", name: "CineStar Praha Anděl", city: "Praha" },
  { slug: "praha9", name: "CineStar Praha Černý Most", city: "Praha" },
] as const;

export type CineStarCinema = (typeof CINESTAR_CINEMAS)[number];

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

type TokenResponse = { token: string; validity?: string };

let cachedToken: { token: string; clientUuid: string; expiresAt: number } | undefined;

/** Refresh a little early so a token never expires mid-sweep. */
const TOKEN_SAFETY_MARGIN_MS = 60_000;

/**
 * Tokens last ~30 minutes. `X-Client` must carry a stable UUID for the lifetime
 * of the token — the API rejects the pair otherwise.
 */
export async function getToken(): Promise<{ token: string; clientUuid: string }> {
  if (cachedToken && Date.now() < cachedToken.expiresAt) {
    return { token: cachedToken.token, clientUuid: cachedToken.clientUuid };
  }

  const apiKey = process.env.CINESTAR_API_KEY;
  if (!apiKey) throw new Error("CINESTAR_API_KEY is not set");

  const clientUuid = crypto.randomUUID();
  const res = await fetchJson<TokenResponse>(`${API}/api/token/create`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: ORIGIN,
      "X-Client": clientUuid,
    },
    body: JSON.stringify({ api_key: apiKey }),
  });
  if (!res.token) throw new Error("CineStar token endpoint returned no token");

  const expiresAt = res.validity
    ? new Date(res.validity).getTime() - TOKEN_SAFETY_MARGIN_MS
    : Date.now() + 20 * 60_000;

  cachedToken = { token: res.token, clientUuid, expiresAt };
  return { token: res.token, clientUuid };
}

/** Test seam; also used when a request comes back unauthorised. */
export function resetToken() {
  cachedToken = undefined;
}

async function authedPost<T>(path: string, body: unknown): Promise<T> {
  const { token, clientUuid } = await getToken();
  return fetchJson<T>(`${API}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: ORIGIN,
      "X-Client": clientUuid,
      token,
    },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------

export type ScheduledEvent = {
  eventId: string;
  /** ISO instant — the programme payload carries a real UTC offset. */
  startsAt: Date;
  /** Identifies a film *version* (dubbed and subtitled have different ids). */
  titleId: string;
  /** CineStar `venueid` (a hall). */
  objectId: string;
  /** Property names as shown on the site: "Dabing", "Titulky", "4K", "Premiéra"… */
  properties: string[];
};

export type Programme = {
  events: ScheduledEvent[];
  /** Hall `ObjectId` → `cinemaid`, published alongside the schedule. */
  hallCinemas: Record<string, string>;
};

/**
 * Parse a cinema's programme page.
 *
 * Nuxt embeds its payload as a flat array where object values are indices into
 * that same array, so reading it means dereferencing one level.
 *
 * The payload turns out to carry almost everything: showtimes with a real UTC
 * offset, the hall, the language version and format tags, and the hall→cinema
 * mapping. The one thing it does not contain is the film's name — `TitleId` is
 * never resolved to a title anywhere on the page.
 */
export function parseProgramme(html: string): Programme {
  const empty: Programme = { events: [], hallCinemas: {} };
  const match = html.match(
    /<script type="application\/json"[^>]*id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/,
  );
  if (!match) return empty;

  let flat: unknown[];
  try {
    flat = JSON.parse(match[1]) as unknown[];
  } catch {
    return empty;
  }

  const deref = (v: unknown): unknown =>
    typeof v === "number" && Number.isInteger(v) && v >= 0 && v < flat.length ? flat[v] : v;
  const str = (v: unknown): string => (typeof deref(v) === "string" ? (deref(v) as string) : "");

  const events = new Map<string, ScheduledEvent>();
  const hallCinemas: Record<string, string> = {};

  for (const entry of flat) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const rec = entry as Record<string, unknown>;

    // Hall records tell us which cinema a hall belongs to, which saves an
    // event lookup per screening just to learn the cinema id.
    if ("CinemaId" in rec && "ObjectId" in rec) {
      const hall = str(rec.ObjectId);
      const cinema = str(rec.CinemaId);
      if (hall && cinema) hallCinemas[hall] = cinema;
      continue;
    }

    if (!("EventId" in rec) || !("Start" in rec)) continue;
    const eventId = str(rec.EventId);
    const start = str(rec.Start);
    if (!eventId || !start) continue;

    const startsAt = new Date(start);
    if (Number.isNaN(startsAt.getTime())) continue;

    const rawProps = deref(rec.Properties);
    const properties = Array.isArray(rawProps)
      ? rawProps
          .map((p) => {
            const prop = deref(p);
            return prop && typeof prop === "object"
              ? str((prop as Record<string, unknown>).Name)
              : "";
          })
          .filter(Boolean)
      : [];

    events.set(eventId, {
      eventId,
      startsAt,
      titleId: str(rec.TitleId),
      objectId: str(rec.ObjectId),
      properties,
    });
  }

  return { events: [...events.values()], hallCinemas };
}

export async function fetchProgramme(slug: string): Promise<Programme> {
  const html = await fetchText(`${WEB}/cz/${slug}/program`, { timeoutMs: 30_000 });
  return parseProgramme(html);
}

/** Language version, read from the programme page's own property tags. */
export function versionFromProperties(properties: readonly string[]): string | null {
  for (const p of properties) {
    const v = p.trim().toLowerCase();
    if (v === "dabing") return "dabing";
    if (v === "titulky") return "titulky";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Event metadata
// ---------------------------------------------------------------------------

export type CsEvent = {
  eventid: number;
  titleid: number;
  title_groupid: number;
  venueid: number;
  venue: string;
  /** Wall-clock Prague time, no offset. */
  start: string;
  duration_minutes: number;
  cinemaid: number;
  title: string;
  title_group: string;
  subtitle_group: string | null;
  event_properties: { propertyid: number; name: string; type: string }[] | null;
};

export function fetchEvent(eventId: string): Promise<CsEvent> {
  return authedPost<CsEvent>("/api/event/get", { eventId });
}

// ---------------------------------------------------------------------------
// Occupancy
// ---------------------------------------------------------------------------

export type CsSeat = { state: string; row: string; seat: number };
export type CsHall = {
  seats: CsSeat[] | null;
  prices: { price_categoryid: number; price: number; currency: string }[] | null;
};

/** Errors the API returns as HTTP 200 with a status code in the body. */
export type CsApiError = { statuscode: number; code: string; description: string };

/**
 * A screening that has already started is no longer "shared" and its occupancy
 * becomes unreadable — permanently. This is why the poller has to reach every
 * screening before showtime rather than tidying up afterwards.
 */
export const EVENT_GONE_CODES = new Set(["E_API_EVENT_NOT_SHARED", "E_API_EVENT_NOT_FOUND"]);

export class EventGoneError extends Error {
  constructor(readonly eventId: string, readonly code: string) {
    super(`CineStar event ${eventId} is no longer readable (${code})`);
    this.name = "EventGoneError";
  }
}

export async function fetchHall(eventId: string): Promise<CsHall> {
  const res = await authedPost<CsHall | CsApiError>("/api/hall/get", { eventId });
  if ("code" in res && typeof res.code === "string") {
    if (EVENT_GONE_CODES.has(res.code)) throw new EventGoneError(eventId, res.code);
    throw new Error(`CineStar hall/get failed for ${eventId}: ${res.code}`);
  }
  return res as CsHall;
}

export type Occupancy = {
  seatsSold: number;
  seatsTotal: number;
  priceMin: number | null;
  priceMax: number | null;
};

/**
 * Sampling 36 halls (4382 seats) turned up only FREE and OCCUPIED, so anything
 * unrecognised is counted as sold rather than silently dropped — undercounting
 * admissions would be the worse failure for a producer reading these numbers.
 *
 * The unsellable list is a guard for states we have not observed but that would
 * distort capacity if they ever appeared; such seats are excluded from the
 * total rather than counted as sold.
 */
const FREE_STATES = new Set(["FREE"]);
const UNSELLABLE_STATES = new Set(["BROKEN", "BLOCKED", "DISABLED"]);

export function readOccupancy(hall: CsHall): Occupancy {
  const seats = hall.seats ?? [];
  let seatsTotal = 0;
  let seatsSold = 0;
  for (const s of seats) {
    const state = (s.state ?? "").toUpperCase();
    if (UNSELLABLE_STATES.has(state)) continue;
    seatsTotal += 1;
    if (!FREE_STATES.has(state)) seatsSold += 1;
  }

  const prices = (hall.prices ?? []).map((p) => p.price).filter((p) => Number.isFinite(p) && p > 0);
  return {
    seatsSold,
    seatsTotal,
    priceMin: prices.length ? Math.min(...prices) : null,
    priceMax: prices.length ? Math.max(...prices) : null,
  };
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/** Version markers CineStar appends to the film title on a per-screening basis. */
const VERSION_SUFFIXES = [
  { re: /\s+DABING\s*$/i, value: "dabing" },
  { re: /\s+TITULKY\s*$/i, value: "titulky" },
] as const;

export function splitVersion(title: string): { title: string; languageVersion: string | null } {
  for (const { re, value } of VERSION_SUFFIXES) {
    if (re.test(title)) return { title: title.replace(re, "").trim(), languageVersion: value };
  }
  return { title: title.trim(), languageVersion: null };
}

export type NormalizedCsScreening = {
  chain: "cinestar";
  externalId: string;
  startsAt: Date;
  cinema: { externalId: string };
  hall: { externalId: string; name: string };
  film: { externalId: string; title: string; originalTitle: string | null };
  formatAttrs: string[];
  languageVersion: string | null;
};

export function normalizeEvent(e: CsEvent): NormalizedCsScreening {
  const { languageVersion } = splitVersion(e.title);
  const props = e.event_properties ?? [];
  return {
    chain: "cinestar",
    externalId: String(e.eventid),
    startsAt: pragueToUtc(e.start),
    cinema: { externalId: String(e.cinemaid) },
    hall: { externalId: String(e.venueid), name: e.venue },
    film: {
      // title_groupid merges the dubbed and subtitled variants of one film.
      externalId: String(e.title_groupid),
      title: e.title_group,
      originalTitle: e.subtitle_group || null,
    },
    formatAttrs: normalizeFormats(props.map((p) => p.name)),
    languageVersion,
  };
}
