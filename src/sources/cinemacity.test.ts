import { describe, expect, it } from "vitest";

import fixture from "./__fixtures__/cinemacity-presentations.json";
import seatplan from "./__fixtures__/cinemacity-seatplan.json";
import {
  CAPACITY_RESIDUAL_TOLERANCE,
  normalize,
  seatsSoldFromRatio,
  type CcPresentation,
} from "./cinemacity";

const presentations = fixture.presentations as unknown as CcPresentation[];

/** Capacity of hall 44 (Brno Olympia, Sál 10) as published in the seatplan fixture. */
const HALL_44_CAPACITY = Object.values(seatplan.sections).reduce(
  (sum, s) => sum + (s as { Capacity: number }).Capacity,
  0,
);

describe("seatplan capacity", () => {
  it("sums section capacities", () => {
    expect(HALL_44_CAPACITY).toBe(158);
  });
});

describe("seatsSoldFromRatio", () => {
  it("resolves the ratio to whole seats on real data", () => {
    // This is the load-bearing assumption of the whole Cinema City source: if
    // availRatio were bucketed rather than exact, these residuals would be large.
    const hall44 = presentations.filter((p) => p.venueId === 44);
    expect(hall44.length).toBeGreaterThan(0);

    for (const p of hall44) {
      const { residual } = seatsSoldFromRatio(HALL_44_CAPACITY, p.availRatio);
      expect(residual).toBeLessThan(CAPACITY_RESIDUAL_TOLERANCE);
    }
  });

  it("matches the hand-checked screening", () => {
    // Brno Olympia, Sál 10, 2026-07-31 18:00: ratio 0.2405 of 158 seats.
    const { seatsSold } = seatsSoldFromRatio(158, 0.2405);
    expect(seatsSold).toBe(120);
  });

  it("treats a full house as zero sold and a sellout as capacity", () => {
    expect(seatsSoldFromRatio(158, 1).seatsSold).toBe(0);
    expect(seatsSoldFromRatio(158, 0).seatsSold).toBe(158);
  });

  it("clamps rather than returning impossible seat counts", () => {
    expect(seatsSoldFromRatio(100, 1.2).seatsSold).toBe(0);
    expect(seatsSoldFromRatio(100, -0.2).seatsSold).toBe(100);
  });

  it("flags a stale capacity via the residual", () => {
    // A ratio that cannot be explained by this capacity — the hall was re-seated.
    const { residual } = seatsSoldFromRatio(101, 0.2405);
    expect(residual).toBeGreaterThan(CAPACITY_RESIDUAL_TOLERANCE);
  });
});

describe("normalize", () => {
  it("maps a presentation onto our domain shape", () => {
    const p = presentations.find((x) => x.venueId === 44)!;
    const n = normalize(p);

    expect(n.chain).toBe("cinema_city");
    expect(n.externalId).toBe(String(p.id));
    expect(n.cinema.externalId).toBe("1034");
    expect(n.hall.externalId).toBe("44");
    expect(n.hall.seatplanExternalId).toBe("1");
    expect(n.film.title).toBe("Spider-Man: Zbrusu nový den");
    expect(n.film.originalTitle).toBe("Spider-Man: Brand New Day");
    expect(n.screeningDay).toBe(p.businessDate);
  });

  it("reads the local wall clock as Prague time", () => {
    const p = presentations.find((x) => x.dateTime.endsWith("12:00"))!;
    // 12:00 Prague in July is CEST (UTC+2), so 10:00 UTC.
    expect(normalize(p).startsAt.toISOString()).toBe(
      `${p.dateTime.slice(0, 10)}T10:00:00.000Z`,
    );
  });

  it("derives the language version from the language ISO fields", () => {
    const dubbed = presentations.find((p) => p.dubbedLanguageISO === "cs");
    if (dubbed) expect(normalize(dubbed).languageVersion).toBe("dabing");
  });
});
