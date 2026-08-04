import { describe, expect, it } from "vitest";

import { emptyState, type Screening, type State } from "@/store/types";

import { repairClosedReadings } from "./goldenapple";

const NOW = new Date("2026-08-03T11:20:00.000Z");

function withScreening(over: Partial<Screening>): State {
  const state = emptyState();
  state.screenings["golden_apple:1"] = {
    chain: "golden_apple",
    filmId: 1,
    hallKey: "golden_apple:Multikino/Sál 2",
    startsAt: "2026-08-03T08:00:00.000Z",
    day: "2026-08-03",
    sold: 122,
    total: 122,
    at: "2026-08-03T11:12:00.000Z",
    nextPollAt: null,
    formats: [],
    lang: null,
    soldOut: false,
    priceMin: null,
    priceMax: null,
    ...over,
  };
  return state;
}

describe("repairClosedReadings", () => {
  it("throws away a full house measured after the film started", () => {
    // Datakal greys out every seat once sales close, so a 10:00 screening read
    // at 13:00 comes back as 122/122. Seven of ours were sitting like that.
    const state = withScreening({});
    expect(repairClosedReadings(state, NOW)).toBe(1);
    expect(state.screenings["golden_apple:1"]).toMatchObject({ sold: null, total: null, at: null });
  });

  it("settles a discarded reading as missed rather than as nobody came", () => {
    const state = withScreening({
      settled: { sold: 122, total: 122, confidence: "final", capturedAt: "2026-08-03T11:12:00.000Z" },
    });
    repairClosedReadings(state, NOW);
    expect(state.screenings["golden_apple:1"].settled).toMatchObject({
      sold: 0,
      confidence: "missed",
    });
  });

  it("keeps a real sell-out of a screening that has not started", () => {
    const state = withScreening({ startsAt: "2026-08-03T18:00:00.000Z" });
    expect(repairClosedReadings(state, NOW)).toBe(0);
    expect(state.screenings["golden_apple:1"].sold).toBe(122);
  });

  it("keeps a full house captured before the film started", () => {
    const state = withScreening({ at: "2026-08-03T07:55:00.000Z" });
    expect(repairClosedReadings(state, NOW)).toBe(0);
  });

  it("leaves a partly sold screening alone", () => {
    const state = withScreening({ sold: 6, total: 90 });
    expect(repairClosedReadings(state, NOW)).toBe(0);
  });

  it("ignores the other chains, which do not answer this way", () => {
    const state = withScreening({ chain: "cinestar" });
    expect(repairClosedReadings(state, NOW)).toBe(0);
  });
});
