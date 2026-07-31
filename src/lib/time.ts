const ZONE = "Europe/Prague";

/**
 * Screenings that start after midnight belong to the previous cinema day.
 * Cinema City ships a `businessDay` field that follows this convention;
 * CineStar ships nothing equivalent, so we derive it identically for both
 * rather than letting the two chains disagree about which day a 00:30 show
 * counts towards.
 */
const BUSINESS_DAY_CUTOFF_HOUR = 5;

const partsFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

/** Offset of Europe/Prague from UTC, in milliseconds, at a given instant. */
function zoneOffsetMs(instant: Date): number {
  const parts = partsFormatter.formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value);
  // `formatToParts` renders midnight as hour 24 rather than 0.
  const hour = get("hour") % 24;
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), hour, get("minute"), get("second"));
  return asUtc - instant.getTime();
}

export type NaiveLocal = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

/**
 * Both chains publish wall-clock Prague time with no offset: Cinema City as
 * "2026-07-31 12:00" or "2026-07-31T12:00:00", CineStar as "2026-07-31T10:00:00".
 */
export function parseNaive(input: string): NaiveLocal {
  const m = input.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) throw new Error(`Unrecognised naive local timestamp: ${input}`);
  return {
    year: Number(m[1]),
    month: Number(m[2]),
    day: Number(m[3]),
    hour: Number(m[4]),
    minute: Number(m[5]),
    second: Number(m[6] ?? 0),
  };
}

/**
 * Convert wall-clock Prague time to a real instant.
 *
 * The offset depends on the instant we are trying to compute, so we guess with
 * the UTC interpretation and then re-derive once. The second pass is what makes
 * the hour around a DST transition come out right.
 */
export function pragueToUtc(input: string): Date {
  const n = parseNaive(input);
  const guess = Date.UTC(n.year, n.month - 1, n.day, n.hour, n.minute, n.second);
  let instant = guess - zoneOffsetMs(new Date(guess));
  instant = guess - zoneOffsetMs(new Date(instant));
  return new Date(instant);
}

/** `YYYY-MM-DD` of the cinema day a wall-clock Prague timestamp belongs to. */
export function businessDay(input: string): string {
  const n = parseNaive(input);
  const shifted = new Date(Date.UTC(n.year, n.month - 1, n.day));
  if (n.hour < BUSINESS_DAY_CUTOFF_HOUR) shifted.setUTCDate(shifted.getUTCDate() - 1);
  return shifted.toISOString().slice(0, 10);
}

/** Wall-clock Prague time for a real instant, as `YYYY-MM-DDTHH:mm:ss`. */
export function pragueWallClock(instant: Date): string {
  const parts = partsFormatter.formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)!.value;
  const hour = String(Number(get("hour")) % 24).padStart(2, "0");
  return `${get("year")}-${get("month")}-${get("day")}T${hour}:${get("minute")}:${get("second")}`;
}

/** Cinema day for a real instant, applying the same cutoff as `businessDay`. */
export const businessDayFromInstant = (instant: Date) => businessDay(pragueWallClock(instant));

/** `YYYY-MM-DD` in Prague for a real instant (used for "today" in queries). */
export function pragueDate(instant: Date = new Date()): string {
  const parts = partsFormatter.formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}
