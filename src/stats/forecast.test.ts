import { describe, expect, it } from "vitest";

import { forecast, normalizeRun, originOf, type WeekendPoint } from "./forecast";

const point = (weekOfRun: number, weekendAdmissions: number, totalAdmissions: number): WeekendPoint => ({
  weekOfRun,
  weekendAdmissions,
  totalAdmissions,
});

describe("forecast", () => {
  it("never predicts fewer admissions than have already happened", () => {
    const f = forecast("cz", [point(9, 400, 250_000)])!;
    expect(f.total).toBeGreaterThanOrEqual(250_000);
    expect(f.low).toBeGreaterThanOrEqual(250_000);
  });

  it("uses the film's own curve once there are two weekends", () => {
    const assumed = forecast("foreign", [point(1, 100_000, 110_000)])!;
    expect(assumed.measured).toBe(false);
    expect(assumed.strength).toBeUndefined();

    // Holding at 0.80 where the market typically drops to 0.516 is a film with
    // legs, so its strength is well above one.
    const holding = forecast("foreign", [point(1, 100_000, 110_000), point(2, 80_000, 240_000)])!;
    expect(holding.measured).toBe(true);
    expect(holding.strength).toBeGreaterThan(1.4);
  });

  it("reads every weekend, not just the last pair", () => {
    // Same final step, different history: a film that has been holding well
    // all along must project above one that has been sliding and just had a
    // flat week.
    const steady = forecast("foreign", [
      point(1, 100_000, 110_000), point(2, 70_000, 210_000), point(3, 49_000, 290_000),
    ])!;
    const collapsed = forecast("foreign", [
      point(1, 100_000, 110_000), point(2, 30_000, 160_000), point(3, 21_000, 200_000),
    ])!;
    expect(steady.strength).toBeGreaterThan(collapsed.strength!);
  });

  it("projects a leggy film above a front-loaded one from the same opening", () => {
    // The second weekend is the signal the whole model turns on.
    const legs = forecast("cz", [point(1, 100_000, 110_000), point(2, 75_000, 230_000)])!;
    const frontloaded = forecast("cz", [point(1, 100_000, 110_000), point(2, 30_000, 160_000)])!;
    expect(legs.total).toBeGreaterThan(frontloaded.total * 1.4);
  });

  it("gives Czech films longer legs than foreign ones", () => {
    // Measured: Czech runs hold better from the third weekend on.
    const cz = forecast("cz", [point(1, 100_000, 110_000)])!;
    const foreign = forecast("foreign", [point(1, 100_000, 110_000)])!;
    expect(cz.total).toBeGreaterThan(foreign.total);
  });

  it("does not treat a preview weekend as the opening", () => {
    // UFD numbers previews below one. Dividing by a 32k preview instead of the
    // 57k premiere turned one real run into a 9.6x multiplier.
    const withPreview = forecast("foreign", [
      point(-1, 32_299, 32_299),
      point(1, 56_944, 105_000),
      point(2, 27_043, 160_000),
    ])!;
    expect(withPreview.multiplier).toBeLessThan(6);
    // The preview's admissions still count — they are inside the running total,
    // so soFar (and therefore the forecast) includes every preview ticket. The
    // preview is excluded from the *decay basis and multiplier only*, never
    // from attendance.
    expect(withPreview.soFar).toBe(160_000);
    expect(withPreview.total).toBeGreaterThanOrEqual(160_000);
  });

  it("reports no multiplier when the run was picked up mid-flight", () => {
    const f = forecast("cz", [point(9, 5_000, 250_000), point(10, 4_000, 258_000)])!;
    expect(f.multiplier).toBeUndefined();
  });

  it("refuses a run with nothing in it", () => {
    expect(forecast("cz", [])).toBeNull();
    expect(forecast("cz", [point(1, 0, 0)])).toBeNull();
  });

  it("refuses a preview-only run, before there is any opening weekend", () => {
    // A film UFD has only listed in preview (week -1) has no opening to forecast
    // from; predicting off it produced a "week -1" estimate and a broken chart.
    expect(forecast("foreign", [point(-1, 3_000, 3_000)])).toBeNull();
    expect(forecast("cz", [point(-2, 500, 500), point(-1, 800, 1_300)])).toBeNull();
  });

  it("caps a film that grew week on week rather than extrapolating to infinity", () => {
    // Holiday weeks really do rise; a hold above 1 compounded forever would not.
    const f = forecast("cz", [point(1, 50_000, 55_000), point(2, 65_000, 150_000)])!;
    expect(f.hold).toBeLessThanOrEqual(0.95);
    expect(Number.isFinite(f.total)).toBe(true);
  });
});

describe("originOf", () => {
  it("reads UFD's country code", () => {
    expect(originOf({ country: "CZE" })).toBe("cz");
    expect(originOf({ country: "CZ" })).toBe("cz");
    expect(originOf({ country: "USA" })).toBe("foreign");
  });

  it("falls back to whether an original title exists", () => {
    // The chains publish no original title for a Czech production, because
    // there isn't one to publish.
    expect(originOf({ title: "Vlny", originalTitle: null })).toBe("cz");
    expect(originOf({ title: "Odyssea", originalTitle: "The Odyssey" })).toBe("foreign");
  });
});

describe("normalizeRun", () => {
  it("treats UFD's week 0 as the opening, reindexed to 1", () => {
    // 711 of 789 week-0 films open there; dropping it lost the real premiere.
    const out = normalizeRun([point(0, 21_323, 21_323), point(1, 23_523, 47_000)]);
    expect(out.map((p) => p.weekOfRun)).toEqual([1, 2]);
    expect(out[0].weekendAdmissions).toBe(21_323);
  });

  it("drops an explicitly-numbered preview however large", () => {
    const out = normalizeRun([point(-1, 32_299, 32_299), point(1, 56_944, 105_000)]);
    expect(out.map((p) => p.weekOfRun)).toEqual([1]);
  });

  it("drops a tiny week-0 preview but keeps a full-size week-0 opening", () => {
    expect(normalizeRun([point(0, 4_716, 4_716), point(1, 74_812, 80_000)])).toHaveLength(1);
    expect(normalizeRun([point(0, 21_323, 21_323), point(1, 23_523, 47_000)])).toHaveLength(2);
  });
});

describe("forecast with screen signals", () => {
  const opening = (weekend: number, cinemas: number) => [
    { weekOfRun: 1, weekendAdmissions: weekend, totalAdmissions: weekend, cinemas },
  ];

  it("projects a packed opening leggier than a thin one", () => {
    // Same opening weekend, very different intensity per cinema.
    const packed = forecast("cz", opening(60_000, 150))!; // 400/cinema
    const thin = forecast("cz", opening(60_000, 600))!; // 100/cinema
    expect(packed.total).toBeGreaterThan(thin.total);
    expect(packed.strength).toBeGreaterThan(thin.strength!);
  });

  it("does not move the estimate when screens fall at the normal pace", () => {
    // The typical week-2 film keeps 0.711 of its screens; a film doing exactly
    // that carries no signal and must land on the no-planned-ratio estimate.
    const plain = forecast("foreign", [point(1, 100_000, 110_000), point(2, 60_000, 200_000)])!;
    const normal = forecast(
      "foreign",
      [point(1, 100_000, 110_000), point(2, 60_000, 200_000)],
      { plannedScreenRatio: 0.711 },
    )!;
    expect(normal.screenTrend).toBeCloseTo(1, 2);
    expect(normal.total).toBe(plain.total);
  });

  it("cuts only when screens fall faster than the normal decline", () => {
    const normal = forecast("foreign", [point(1, 100_000, 110_000), point(2, 60_000, 200_000)], {
      plannedScreenRatio: 0.711,
    })!;
    const collapsing = forecast("foreign", [point(1, 100_000, 110_000), point(2, 60_000, 200_000)], {
      plannedScreenRatio: 0.4, // against a 0.711 norm, well below
    })!;
    expect(collapsing.total).toBeLessThan(normal.total);
    expect(collapsing.screenTrend).toBeLessThan(1);
  });

  it("clamps a deviation that is scraping noise", () => {
    const f = forecast("foreign", [point(1, 100_000, 110_000)], { plannedScreenRatio: 0.001 })!;
    // Normalized (÷0.602) then clamped into the trusted deviation band.
    expect(f.screenTrend).toBe(0.5);
  });
});
