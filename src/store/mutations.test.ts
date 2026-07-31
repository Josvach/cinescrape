import { describe, expect, it } from "vitest";

import { recordReading, resolveFilm, upsertScreening } from "./mutations";
import { emptyState, key, type State } from "./types";

const seed = (): State => emptyState();

const screening = (state: State, startsAt = "2026-08-02T18:00:00.000Z") =>
  upsertScreening(state, {
    chain: "cinema_city",
    externalId: "1",
    filmId: 1,
    hallKey: "cinema_city:44",
    startsAt: new Date(startsAt),
    day: "2026-08-02",
    formats: [],
    lang: null,
    soldOut: false,
  });

describe("resolveFilm", () => {
  it("merges the same film across chains", () => {
    const state = seed();
    const cc = resolveFilm(state, {
      chain: "cinema_city",
      externalId: "622",
      title: "Spider-Man: Zbrusu nový den",
      originalTitle: "Spider-Man: Brand New Day",
    });
    const cs = resolveFilm(state, {
      chain: "cinestar",
      externalId: "10572",
      title: "Spider-Man: Zbrusu nový den",
      originalTitle: "Spider-Man: Brand New Day",
    });
    expect(cc).toBe(cs);
    expect(state.films).toHaveLength(1);
  });

  it("bridges the chains' differing transliterations", () => {
    const state = seed();
    const a = resolveFilm(state, {
      chain: "cinema_city",
      externalId: "1",
      title: "Umamusume",
      originalTitle: "Uma Musume Pretty Derby: Shinjidai no Tobira",
    });
    const b = resolveFilm(state, {
      chain: "cinestar",
      externalId: "2",
      title: "Umamusume",
      originalTitle: "Umamusume Pretty Derby: Shinjidai no Tobira",
    });
    expect(a).toBe(b);
  });

  it("keeps different films apart", () => {
    const state = seed();
    const a = resolveFilm(state, {
      chain: "cinema_city", externalId: "1",
      title: "Tlapková patrola: Dinosauří film", originalTitle: "Paw Patrol: The Dino Movie",
    });
    const b = resolveFilm(state, {
      chain: "cinema_city", externalId: "2",
      title: "Tlapková patrola ve velkofilmu", originalTitle: "",
    });
    expect(a).not.toBe(b);
    expect(state.films).toHaveLength(2);
  });

  it("reuses the alias without re-matching", () => {
    const state = seed();
    const first = resolveFilm(state, {
      chain: "cinestar", externalId: "10572", title: "Odyssea", originalTitle: "The Odyssey",
    });
    // Same external id, title since renamed upstream — the alias still wins.
    const second = resolveFilm(state, {
      chain: "cinestar", externalId: "10572", title: "Odyssea (repríza)", originalTitle: null,
    });
    expect(second).toBe(first);
    expect(state.films).toHaveLength(1);
  });
});

describe("recordReading", () => {
  it("does not credit the first reading to the ramp", () => {
    // Whatever a screening had already sold happened before we were watching;
    // booking it as this hour's sales would invent a spike that never occurred.
    const state = seed();
    const s = screening(state);
    recordReading(state, s, { sold: 120, total: 158, at: new Date("2026-08-01T10:05:00Z") });

    expect(s.sold).toBe(120);
    expect(state.ramp).toEqual([]);
  });

  it("credits only the increase to the ramp", () => {
    const state = seed();
    const s = screening(state);
    recordReading(state, s, { sold: 120, total: 158, at: new Date("2026-08-01T10:05:00Z") });
    recordReading(state, s, { sold: 131, total: 158, at: new Date("2026-08-01T10:35:00Z") });

    expect(state.ramp).toEqual([{ at: "2026-08-01T10", byFilm: { "1": 11 } }]);
  });

  it("accumulates within an hour and splits across hours", () => {
    const state = seed();
    const s = screening(state);
    recordReading(state, s, { sold: 100, total: 158, at: new Date("2026-08-01T10:00:00Z") });
    recordReading(state, s, { sold: 105, total: 158, at: new Date("2026-08-01T10:30:00Z") });
    recordReading(state, s, { sold: 108, total: 158, at: new Date("2026-08-01T10:50:00Z") });
    recordReading(state, s, { sold: 115, total: 158, at: new Date("2026-08-01T11:10:00Z") });

    expect(state.ramp).toEqual([
      { at: "2026-08-01T10", byFilm: { "1": 8 } },
      { at: "2026-08-01T11", byFilm: { "1": 7 } },
    ]);
  });

  it("ignores a decrease rather than subtracting from sales", () => {
    // Refunds and released holds are real, but they are not sales.
    const state = seed();
    const s = screening(state);
    recordReading(state, s, { sold: 100, total: 158, at: new Date("2026-08-01T10:00:00Z") });
    recordReading(state, s, { sold: 96, total: 158, at: new Date("2026-08-01T10:30:00Z") });

    expect(s.sold).toBe(96);
    expect(state.ramp).toEqual([]);
  });

  it("keeps buckets sorted when a late reading lands out of order", () => {
    const state = seed();
    const s = screening(state);
    recordReading(state, s, { sold: 10, total: 158, at: new Date("2026-08-01T12:00:00Z") });
    recordReading(state, s, { sold: 20, total: 158, at: new Date("2026-08-01T12:30:00Z") });
    recordReading(state, s, { sold: 25, total: 158, at: new Date("2026-08-01T11:30:00Z") });

    expect(state.ramp.map((b) => b.at)).toEqual(["2026-08-01T11", "2026-08-01T12"]);
  });

  it("keeps films apart inside one bucket", () => {
    const state = seed();
    const a = screening(state);
    const b = upsertScreening(state, {
      chain: "cinema_city", externalId: "2", filmId: 2, hallKey: "cinema_city:44",
      startsAt: new Date("2026-08-02T20:00:00Z"), day: "2026-08-02",
      formats: [], lang: null, soldOut: false,
    });
    for (const [s, from, to] of [[a, 10, 15] as const, [b, 30, 33] as const]) {
      recordReading(state, s, { sold: from, total: 158, at: new Date("2026-08-01T10:00:00Z") });
      recordReading(state, s, { sold: to, total: 158, at: new Date("2026-08-01T10:20:00Z") });
    }
    expect(state.ramp).toEqual([{ at: "2026-08-01T10", byFilm: { "1": 5, "2": 3 } }]);
  });
});

describe("upsertScreening", () => {
  it("preserves readings when the screening is seen again", () => {
    const state = seed();
    const s = screening(state);
    recordReading(state, s, { sold: 50, total: 158 });

    const again = screening(state);
    expect(again.sold).toBe(50);
    expect(Object.keys(state.screenings)).toEqual([key("cinema_city", "1")]);
  });

  it("picks up a rescheduled start", () => {
    const state = seed();
    screening(state);
    const moved = screening(state, "2026-08-02T19:30:00.000Z");
    expect(moved.startsAt).toBe("2026-08-02T19:30:00.000Z");
  });
});
