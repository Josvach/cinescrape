/**
 * When to next poll a CineStar screening.
 *
 * Cinema City comes back whole in one request, so only CineStar needs a
 * priority queue: it costs one request per screening, and there are thousands.
 *
 * The cadence tightens as showtime approaches for two reasons. Sales accelerate
 * near the show, so the interesting part of the ramp is the last few hours; and
 * once a screening starts its occupancy becomes unreadable forever, so the last
 * snapshot we manage to take *is* the admissions figure.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** How close to showtime the final snapshot must land to count as `final`. */
export const FINAL_CAPTURE_WINDOW_MS = 15 * MINUTE;

/** Aim slightly inside the window so a late run still lands in time. */
const FINAL_CAPTURE_TARGET_MS = 5 * MINUTE;

const TIERS = [
  { withinMs: 2 * HOUR, intervalMs: 10 * MINUTE },
  { withinMs: 12 * HOUR, intervalMs: 30 * MINUTE },
  { withinMs: 48 * HOUR, intervalMs: 2 * HOUR },
] as const;

const FAR_FUTURE_INTERVAL_MS = 12 * HOUR;

/**
 * How soon to look again at a reading we are not willing to believe yet.
 *
 * Short enough that a confirmation still lands well before showtime, long
 * enough that a hall CineStar has taken off sale has a chance to come back.
 */
export const RECHECK_INTERVAL_MS = 5 * MINUTE;

/**
 * Returns the next poll time, or null when the screening is past and should
 * leave the queue.
 */
export function nextPollAt(startsAt: Date, now: Date = new Date()): Date | null {
  const untilStart = startsAt.getTime() - now.getTime();
  if (untilStart <= 0) return null;

  const tier = TIERS.find((t) => untilStart <= t.withinMs);
  const interval = tier?.intervalMs ?? FAR_FUTURE_INTERVAL_MS;
  const candidate = now.getTime() + interval;

  // Never let the regular cadence step over showtime: if the next tick would
  // land after the screening has started, pull it back to just before, so the
  // one snapshot that decides the final number actually gets taken.
  const lastChance = startsAt.getTime() - FINAL_CAPTURE_TARGET_MS;
  if (candidate > lastChance) return new Date(Math.max(now.getTime(), lastChance));

  return new Date(candidate);
}

/**
 * Next poll for a screening we want to look at again sooner than its tier
 * cadence — a reading that needs confirming. Never later than the regular
 * cadence, and never after showtime.
 */
export function recheckPollAt(startsAt: Date, now: Date = new Date()): Date | null {
  const regular = nextPollAt(startsAt, now);
  if (!regular) return null;
  const sooner = now.getTime() + RECHECK_INTERVAL_MS;
  return sooner < regular.getTime() ? new Date(sooner) : regular;
}

/** How much we trust a settled figure, given when its snapshot was captured. */
export function settleConfidence(
  startsAt: Date,
  capturedAt: Date | null,
): "final" | "partial" | "missed" {
  if (!capturedAt) return "missed";
  const lead = startsAt.getTime() - capturedAt.getTime();
  if (lead < 0) return "final"; // captured after the show began: nothing left to sell
  return lead <= FINAL_CAPTURE_WINDOW_MS ? "final" : "partial";
}
