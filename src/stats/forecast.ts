/**
 * Forecasting a film's final Czech admissions from the run so far.
 *
 * The industry rule of thumb is a multiplier on the opening weekend — "times
 * four" is the one people quote. Measured against eleven years of UFD reports
 * that is simply wrong for this market: the median Czech release finishes at
 * 3.0× its opening weekend and the median foreign release at 2.8×. Worse, the
 * spread is enormous (the middle half runs from about 2.1× to 4.0×), so a flat
 * multiplier is a number with no information in it.
 *
 * What does carry information is how the film holds. The literature on box
 * office is unanimous that the second weekend is the signal, and the Czech data
 * agrees sharply — median final multiplier against the second-weekend hold:
 *
 *              hold  <0.35  0.35-45  0.45-55  0.55-65  0.65-80  >0.80
 *     Czech           2.14     2.85     3.22     3.29     4.58    5.40
 *     foreign         1.87     2.60     2.82     3.14     4.05    5.42
 *
 * So the model is not a multiplier at all. It is a decay: weekend admissions
 * fall by a roughly constant factor each week, weekdays add a stable amount on
 * top of each weekend, and the remaining run is the sum of that series.
 *
 *     predicted = admissions so far + last weekend × uplift × r/(1 - r)
 *
 * where `r` is the weekly hold. It is read from the film's whole curve, not
 * just its last step: every consecutive pair says how the film held against
 * what the market typically does at that week of run, and those ratios are
 * averaged geometrically with recent ones weighted higher. Before there is any
 * pair it comes from the calibration table. This degrades gracefully: on
 * opening weekend it is the market's average film, and every further weekend
 * replaces prior with evidence.
 *
 * On a held-out split — calibrated on runs that started before 2023, measured
 * on the ones since — reading the whole curve rather than the last pair alone
 * moves the share of forecasts within 20% of the truth from 77% to 78% at
 * three weekends and 82% to 83% at four. A small gain, and never a loss.
 *
 * One honest caveat: off the opening weekend alone the estimate runs about 7%
 * high at the median. Correcting that needs a fudge factor that did not
 * transfer across the split, so it is left alone and the band — which is wide
 * there for exactly this reason — is what should be read instead.
 *
 * All constants below are medians measured from `history.ufd` — 552 weekly
 * tables, 2015-12 to 2026-07, 1118 completed runs. Medians rather than means
 * because the distribution has a long right tail and a handful of phenomena
 * would otherwise drag the typical film upwards.
 */

/** Czech production, or a foreign one. Their runs behave differently. */
export type Origin = "cz" | "foreign";

/**
 * Weekly hold by week of run, measured separately for each origin.
 *
 * The first drop is much steeper than later ones — around 0.51 either way —
 * and the curve flattens as the film settles into whoever still wants to see
 * it. Using one flat number across the whole run would underestimate the tail
 * of a leggy film and overestimate a front-loaded one.
 */
const HOLD_BY_WEEK: Record<Origin, number[]> = {
  //         1→2    2→3    3→4    4→5    5→6
  cz: [0.51, 0.583, 0.623, 0.656, 0.751],
  foreign: [0.516, 0.618, 0.642, 0.686, 0.701],
};

/**
 * The rate used once the table runs out.
 *
 * The measured hold for weeks six and beyond climbs towards 0.8, but that is
 * survivorship: only films still inside the top 20 that late get reported, and
 * those are by definition the leggy ones. Extrapolating the survivors' rate
 * over every film's tail inflated the typical run by about a tenth. 0.5 is what
 * the backtest settles on across every stage.
 */
const TAIL_HOLD = 0.5;

/**
 * How much a film's own measured hold moves the assumed curve.
 *
 * A first-to-second-weekend drop is the steepest of the run and a noisy single
 * observation, so taking it at face value and applying it to every later week
 * overshoots in both directions — it cost 8 points of median accuracy at the
 * two-week stage. Damping keeps the signal without letting one number decide
 * the whole tail.
 */
const HOLD_CONFIDENCE = 0.4;

/**
 * How much older weekends count against newer ones when reading the curve.
 *
 * Each step back into the run carries this much of the previous weight, so the
 * most recent hold dominates without the earlier ones being discarded. A film
 * five weeks in has told us five things about how it falls off; using only the
 * last of them was leaving most of that on the floor.
 */
const RECENCY_WEIGHT = 0.6;

/**
 * How much a week's total admissions exceed its weekend.
 *
 * UFD counts Thursday to Sunday as the weekend, so this is Monday to Wednesday
 * plus the following Thursday's opening — a stable 1.63 for Czech films and
 * 1.51 for foreign ones.
 */
const WEEKDAY_UPLIFT: Record<Origin, number> = { cz: 1.634, foreign: 1.513 };

/**
 * Beyond this the remaining run is negligible and the geometric series stops
 * being a fair description — prints come out of cinemas rather than decaying
 * forever.
 */
const MAX_FURTHER_WEEKS = 10;

/** A film stops being predictable once almost nobody is going. */
const MIN_WEEKEND_ADMISSIONS = 300;

export type WeekendPoint = {
  /** Week of run as UFD numbers it; 1 is the premiere weekend. */
  weekOfRun: number;
  weekendAdmissions: number;
  /** Cumulative admissions for the whole run at that point. */
  totalAdmissions: number;
};

export type Forecast = {
  /** Best estimate of the film's final admissions. */
  total: number;
  /** Admissions already banked, which the forecast can never fall below. */
  soFar: number;
  /**
   * The hold the model expects next week — the table's rate for that week of
   * run, moved by how this film has actually been holding. Not the last
   * observed ratio: that is one step of a curve, this is where the curve goes.
   */
  hold: number;
  /**
   * How this film holds against the market, 1 being exactly typical. Above one
   * is a film with legs. Absent until there are two weekends to compare.
   */
  strength?: number;
  /** True once the curve came from the film itself rather than the table. */
  measured: boolean;
  /** Weeks of run the estimate is based on. */
  weeks: number;
  /**
   * Plausible range, not a confidence interval in the statistical sense.
   *
   * Backtested against completed runs, so it says "forecasts made at this stage
   * historically landed in here", which is the honest claim.
   */
  low: number;
  high: number;
  /**
   * Multiplier the forecast implies on the opening weekend.
   *
   * Absent unless the series actually starts at the premiere — for a film we
   * only picked up in week nine, the first figure we hold is not an opening
   * weekend and dividing by it produces nonsense like 28×.
   */
  multiplier?: number;
};

const holdFor = (origin: Origin, weekOfRun: number): number => {
  const table = HOLD_BY_WEEK[origin];
  return weekOfRun >= 1 && weekOfRun <= table.length ? table[weekOfRun - 1] : TAIL_HOLD;
};

/**
 * How wide the range is, by how many weekends have been seen.
 *
 * These are the 10th and 90th percentiles of actual-over-predicted from the
 * backtest, so eight runs in ten historically landed inside the band. They are
 * deliberately not pretty round numbers: off the opening weekend alone the real
 * spread is 0.57× to 2.09×, and pretending otherwise would be the whole problem
 * with the "times four" habit repeated in a different form.
 *
 * The asymmetry is real and large. A film can run away upwards far more easily
 * than it can undershoot, because the upside has no ceiling and the downside is
 * bounded by the tickets already sold.
 */
const SPREAD: { low: number; high: number }[] = [
  { low: 0.57, high: 2.09 },
  { low: 0.66, high: 1.35 },
  { low: 0.83, high: 1.3 },
  { low: 0.89, high: 1.29 },
  { low: 0.94, high: 1.27 },
];

/**
 * @param weekends the film's UFD weekend line, oldest first. One entry is
 *   enough; more is better.
 */
export function forecast(origin: Origin, weekends: readonly WeekendPoint[]): Forecast | null {
  const sorted = [...weekends].sort((a, b) => a.weekOfRun - b.weekOfRun);

  // UFD numbers preview weekends below one — "Mimoni a monstra" opened with a
  // week -1 of 32 299 before its real week 1 of 56 944. Those admissions are
  // already inside the running total, but treating a preview as the opening
  // weekend makes the run look like it multiplied nine times over, and the
  // rise from preview to premiere reads as a film gaining momentum.
  const previews = sorted.filter((p) => p.weekOfRun < 1);
  const points = sorted.length > previews.length ? sorted.filter((p) => p.weekOfRun >= 1) : sorted;

  const last = points[points.length - 1];
  if (!last || last.weekendAdmissions <= 0) return null;

  const soFar = Math.max(last.totalAdmissions, last.weekendAdmissions);

  // Read the whole curve, not just its last step.
  //
  // Every consecutive pair says how the film held against what the market
  // typically does at that week of run. Taking only the newest pair throws away
  // most of what a film in its fifth week has already told us, and makes the
  // estimate hostage to one noisy step — a wet weekend, a bank holiday, a
  // competitor opening. Averaging the ratios geometrically, weighted towards
  // the recent ones, uses the shape of the fall-off rather than one edge of it.
  let strength = 1;
  let logSum = 0;
  let weightSum = 0;
  let measured = false;
  for (let i = points.length - 1; i > 0; i--) {
    const before = points[i - 1];
    const after = points[i];
    if (after.weekOfRun !== before.weekOfRun + 1 || before.weekendAdmissions <= 0) continue;
    const observed = after.weekendAdmissions / before.weekendAdmissions;
    if (observed <= 0.05) continue;
    // Weight falls with each step back, so week five still hears week two.
    const weight = RECENCY_WEIGHT ** (points.length - 1 - i);
    // A hold above one happens on holidays and awards bumps and is real, but
    // carrying it forward would send the series upwards forever.
    logSum += Math.log(Math.min(observed, 0.95) / holdFor(origin, before.weekOfRun)) * weight;
    weightSum += weight;
    measured = true;
  }
  if (measured) strength = Math.exp(logSum / weightSum);

  const hold = Math.min(holdFor(origin, last.weekOfRun) * strength, 0.95);

  // Always the ordinary uplift: every week still to come is an ordinary week.
  // The premiere week's own shape is already inside `soFar`, and applying the
  // opening factor to the tail as well understated the median run by 26%.
  const uplift = WEEKDAY_UPLIFT[origin];

  // Decay is not constant — it flattens as the run settles, from about 0.51 on
  // the first drop to nearly 0.7 by week five. Holding the first week's rate
  // for the whole tail cuts the run short; walking the table instead follows
  // the real shape. A film that is holding better or worse than the table
  // shifts the whole curve rather than replacing it, so its own evidence
  // carries forward without pinning every later week to one observation.
  const shift = measured ? strength ** HOLD_CONFIDENCE : 1;

  let remaining = 0;
  let weekend = last.weekendAdmissions;
  for (let week = 0; week < MAX_FURTHER_WEEKS; week++) {
    const rate = Math.min(holdFor(origin, last.weekOfRun + week) * shift, 0.95);
    weekend *= rate;
    if (weekend < MIN_WEEKEND_ADMISSIONS) break;
    remaining += weekend * uplift;
  }

  const total = Math.round(soFar + remaining);
  const spread = SPREAD[Math.min(points.length, SPREAD.length) - 1];

  return {
    total,
    soFar,
    hold: Number(hold.toFixed(3)),
    strength: measured ? Number(strength.toFixed(3)) : undefined,
    measured,
    weeks: last.weekOfRun,
    // The floor is what has already been sold: no forecast may imply that
    // fewer people went than have already gone.
    low: Math.max(soFar, Math.round(total * spread.low)),
    high: Math.round(total * spread.high),
    multiplier:
      points[0].weekOfRun <= 1 && points[0].weekendAdmissions > 0
        ? Number((total / points[0].weekendAdmissions).toFixed(2))
        : undefined,
  };
}

/**
 * Czech or foreign, from whatever the sources tell us.
 *
 * The UFD tables carry a country code; our own catalogue does not, but a film
 * with no original title is one the chains had no original title to publish,
 * which is what a Czech production looks like to them.
 */
export function originOf(input: {
  country?: string | null;
  originalTitle?: string | null;
  title?: string;
}): Origin {
  if (input.country) return /^(CZ|CZE)$/i.test(input.country.trim()) ? "cz" : "foreign";
  if (input.originalTitle && input.title && input.originalTitle !== input.title) return "foreign";
  return input.originalTitle ? "foreign" : "cz";
}
