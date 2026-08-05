import { describe, expect, it } from "vitest";

import { forecast, originOf, type WeekendPoint } from "./forecast";

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

  it("uses the film's own hold once there are two weekends", () => {
    const assumed = forecast("foreign", [point(1, 100_000, 110_000)])!;
    expect(assumed.measured).toBe(false);

    const holding = forecast("foreign", [point(1, 100_000, 110_000), point(2, 80_000, 240_000)])!;
    expect(holding.measured).toBe(true);
    expect(holding.hold).toBeCloseTo(0.8, 2);
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
    // The preview's admissions still count — they are inside the running total.
    expect(withPreview.soFar).toBe(160_000);
  });

  it("reports no multiplier when the run was picked up mid-flight", () => {
    const f = forecast("cz", [point(9, 5_000, 250_000), point(10, 4_000, 258_000)])!;
    expect(f.multiplier).toBeUndefined();
  });

  it("refuses a run with nothing in it", () => {
    expect(forecast("cz", [])).toBeNull();
    expect(forecast("cz", [point(1, 0, 0)])).toBeNull();
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
