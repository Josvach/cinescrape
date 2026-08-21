import { describe, expect, it } from "vitest";

import { emptyState } from "@/store/types";

import { RECHECK_INTERVAL_MS } from "@/core/schedule";

import { applyEventGone, applyHallReading, markAlternativeProgramme } from "./cinestar";

const event = (titleId: string, properties: string[]) => ({
  event: { eventId: "1", startsAt: new Date(), titleId, objectId: "h", properties },
});

function stateWithFilm(id: number, titleId: string) {
  const state = emptyState();
  state.films = [
    { id, matchKey: "k", tightKey: "k", title: "Cirque du Soleil: KOOZA", originalTitle: null },
  ];
  state.cineStarTitles = { [titleId]: id };
  return state;
}

describe("markAlternativeProgramme", () => {
  it("marks a title CineStar calls alternative programme", () => {
    const state = stateWithFilm(39, "10743");
    expect(markAlternativeProgramme(state, [event("10743", ["Alternativní program", "Standard"])])).toBe(1);
    expect(state.films[0].kind).toBe("event");
  });

  it("reaches titles already in the catalogue", () => {
    // The concerts were discovered long before this existed, so marking only
    // newly looked-up titles would never have touched them.
    const state = stateWithFilm(39, "10743");
    state.filmAliases = { "cinestar:10743": 39 };
    expect(markAlternativeProgramme(state, [event("10743", ["Alternativní program"])])).toBe(1);
  });

  it("leaves ordinary films alone", () => {
    const state = stateWithFilm(1, "10550");
    expect(markAlternativeProgramme(state, [event("10550", ["Dabing", "Premium", "HIT"])])).toBe(0);
    expect(state.films[0].kind).toBeUndefined();
  });

  it("counts each film once however many screenings it has", () => {
    const state = stateWithFilm(39, "10743");
    const three = [1, 2, 3].map(() => event("10743", ["Alternativní program"]));
    expect(markAlternativeProgramme(state, three)).toBe(1);
  });
});

const occupancy = (sold: number, total: number) => ({
  seatsSold: sold,
  seatsTotal: total,
  priceMin: 255,
  priceMax: 285,
});

/** The 15:20 in Anděl's Sál 1: 138 seats, five of them sold. */
function screeningState(now: Date) {
  const state = emptyState();
  const startsAt = new Date(now.getTime() + 5 * 60 * 60 * 1000);
  state.screenings["cinestar:1752270"] = {
    chain: "cinestar",
    filmId: 70,
    hallKey: "cinestar:628",
    startsAt: startsAt.toISOString(),
    day: "2026-08-21",
    sold: 3,
    total: 138,
    at: new Date(now.getTime() - 30 * 60_000).toISOString(),
    nextPollAt: now.toISOString(),
    formats: [],
    lang: null,
    soldOut: false,
    priceMin: 255,
    priceMax: 285,
  };
  return { state, screening: state.screenings["cinestar:1752270"], startsAt };
}

describe("applyHallReading", () => {
  const now = new Date("2026-08-21T08:04:56Z");

  it("records an ordinary reading", () => {
    const { state, screening } = screeningState(now);
    expect(applyHallReading(state, screening, occupancy(5, 138), now)).toBe("recorded");
    expect(screening.sold).toBe(5);
    expect(screening.total).toBe(138);
    expect(screening.nextPollAt).not.toBeNull();
  });

  it("holds back a plan with nothing on sale instead of calling it full", () => {
    // CineStar returns every seat OCCUPIED while a screening is off sale, which
    // is what put an all-but-empty hall on the dashboard at 138/138.
    const { state, screening } = screeningState(now);
    expect(applyHallReading(state, screening, occupancy(138, 138), now)).toBe("held");
    expect(screening.sold).toBe(3);
    expect(screening.at).toBe(new Date(now.getTime() - 30 * 60_000).toISOString());
    expect(state.ramp).toEqual([]);
  });

  it("looks again within minutes of holding a reading back", () => {
    const { state, screening } = screeningState(now);
    applyHallReading(state, screening, occupancy(138, 138), now);
    const wait = new Date(screening.nextPollAt!).getTime() - now.getTime();
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThanOrEqual(RECHECK_INTERVAL_MS);
  });

  it("records a house that is still full on the second look", () => {
    const { state, screening } = screeningState(now);
    applyHallReading(state, screening, occupancy(138, 138), now);
    const later = new Date(now.getTime() + RECHECK_INTERVAL_MS);
    expect(applyHallReading(state, screening, occupancy(138, 138), later)).toBe("recorded");
    expect(screening.sold).toBe(138);
  });

  it("forgets the hold as soon as a seat is back on sale", () => {
    const { state, screening } = screeningState(now);
    applyHallReading(state, screening, occupancy(138, 138), now);
    const later = new Date(now.getTime() + RECHECK_INTERVAL_MS);
    expect(applyHallReading(state, screening, occupancy(5, 138), later)).toBe("recorded");
    expect(screening.sold).toBe(5);
    expect(screening.fullSeenAt).toBeUndefined();

    // And a later suspension is held back again rather than believed.
    const evenLater = new Date(later.getTime() + 10 * 60_000);
    expect(applyHallReading(state, screening, occupancy(138, 138), evenLater)).toBe("held");
  });

  it("records an empty hall, which is not the same as an unreadable one", () => {
    const { state, screening } = screeningState(now);
    expect(applyHallReading(state, screening, occupancy(0, 138), now)).toBe("recorded");
    expect(screening.sold).toBe(0);
  });
});

describe("applyEventGone", () => {
  const now = new Date("2026-08-21T08:04:56Z");

  it("keeps a screening that has not started in the queue", () => {
    // It was unreadable at 08:04 and on sale again by lunchtime; dropping it
    // there is what left the bad reading standing.
    const { screening } = screeningState(now);
    applyEventGone(screening, now);
    expect(screening.nextPollAt).not.toBeNull();
    expect(new Date(screening.nextPollAt!).getTime()).toBeGreaterThan(now.getTime());
  });

  it("gives up once the screening has started", () => {
    const { screening } = screeningState(now);
    const afterStart = new Date(new Date(screening.startsAt).getTime() + 60_000);
    applyEventGone(screening, afterStart);
    expect(screening.nextPollAt).toBeNull();
  });
});
