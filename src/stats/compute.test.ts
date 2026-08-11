import { describe, expect, it } from "vitest";

import { computeLive, recordForecasts } from "./compute";
import { emptyHistory, emptyState, type State } from "@/store/types";
import { pragueDate } from "@/lib/time";

const TODAY = pragueDate(new Date());

function stateWith(kinds: ("event" | undefined)[]): State {
  const state = emptyState();
  state.cinemas["cinestar:1"] = { chain: "cinestar", name: "CineStar Hradec Králové", city: "HK" };
  state.halls["cinestar:h"] = { cinemaKey: "cinestar:1", name: "SÁL 4", capacity: null, seatplanId: null };
  kinds.forEach((kind, i) => {
    const id = i + 1;
    state.films.push({
      id,
      matchKey: `k${id}`,
      tightKey: `k${id}`,
      title: kind === "event" ? "Cirque du Soleil: KOOZA" : "Odyssea",
      originalTitle: null,
      ...(kind ? { kind } : {}),
    });
    state.screenings[`cinestar:${id}`] = {
      chain: "cinestar",
      filmId: id,
      hallKey: "cinestar:h",
      startsAt: `${TODAY}T18:00:00.000Z`,
      day: TODAY,
      sold: 100,
      total: 200,
      at: `${TODAY}T12:00:00.000Z`,
      nextPollAt: null,
      formats: [],
      lang: null,
      soldOut: false,
      priceMin: 249,
      priceMax: 249,
    };
  });
  return state;
}

describe("computeLive", () => {
  it("counts an ordinary film", () => {
    const live = computeLive(stateWith([undefined]), emptyHistory());
    expect(live.today.admissions).toBe(100);
  });

  it("leaves concerts and relays out of the film numbers", () => {
    // A Cirque du Soleil sells out weeks ahead, so counted as a film it reads
    // as the strongest release of the week. UFD does not count it either.
    const live = computeLive(stateWith([undefined, "event"]), emptyHistory());
    expect(live.today.admissions).toBe(100);
    expect(live.today.films.map((f) => f.title)).toEqual(["Odyssea"]);
    expect(live.today.fullest.every((s) => !/Cirque/.test(s.film))).toBe(true);
  });
});

describe("recordForecasts", () => {
  const live = (id: number, asOf: string, weeks: number, predicted: number): Parameters<typeof recordForecasts>[1] =>
    ({
      films: [
        {
          id,
          official: { admissions: 0, gross: 0, asOf, sinceAdmissions: 0 },
          forecast: { total: predicted, weeks, low: predicted * 0.9, high: predicted * 1.1 },
        },
      ],
    } as unknown as Parameters<typeof recordForecasts>[1]);

  it("keeps one snapshot per weekly vintage, updated in place", () => {
    const history = emptyHistory();
    // Two runs the same week overwrite; a new week appends.
    recordForecasts(history, live(7, "2026-07-23", 1, 45_000), new Date("2026-07-27T08:00Z"));
    recordForecasts(history, live(7, "2026-07-23", 1, 47_000), new Date("2026-07-27T18:00Z"));
    recordForecasts(history, live(7, "2026-07-30", 2, 30_000), new Date("2026-08-03T10:00Z"));

    const log = history.forecasts!["7"];
    expect(log).toHaveLength(2);
    expect(log[0]).toMatchObject({ asOf: "2026-07-23", predicted: 47_000 });
    expect(log[1]).toMatchObject({ asOf: "2026-07-30", predicted: 30_000 });
  });

  it("skips a film with no official weekend to key on", () => {
    const history = emptyHistory();
    const l = { films: [{ id: 1, forecast: { total: 1, weeks: 1, low: 0, high: 2 } }] };
    recordForecasts(history, l as unknown as Parameters<typeof recordForecasts>[1]);
    expect(history.forecasts).toEqual({});
  });
});
