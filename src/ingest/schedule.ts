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
 * Whether a reading is worth appending to the history.
 *
 * Cinema City hands us all ~3400 screenings on every run, but only a few dozen
 * of them have actually moved — measured live, 99 changed over ten minutes.
 * Storing the other 3300 unchanged rows every five minutes would add nothing to
 * the ramp curve (it is a step function) while writing roughly 29 million rows
 * a month, which no free-tier database survives.
 *
 * So history is append-on-change, throttled by how far away the screening is,
 * and always written inside the final capture window. The live figure on the
 * screening row is updated on every poll regardless — that part is not history.
 */
export function shouldRecordSnapshot(args: {
  previousSeatsSold: number | null;
  seatsSold: number;
  lastCapturedAt: Date | null;
  startsAt: Date;
  now?: Date;
}): boolean {
  const now = args.now ?? new Date();

  // First ever reading of this screening: it is the baseline the curve starts from.
  if (args.previousSeatsSold === null || args.lastCapturedAt === null) return true;

  const untilStart = args.startsAt.getTime() - now.getTime();

  // The reading that decides the final admissions figure is never throttled.
  if (untilStart <= FINAL_CAPTURE_WINDOW_MS) return true;

  if (args.seatsSold === args.previousSeatsSold) return false;

  // Resolution that matters near showtime is wasted a month out, where a film
  // trickling a few presales an hour does not need minute-by-minute history.
  const minGapMs =
    untilStart <= 6 * HOUR ? 0 : untilStart <= 48 * HOUR ? 15 * MINUTE : 60 * MINUTE;

  return now.getTime() - args.lastCapturedAt.getTime() >= minGapMs;
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
