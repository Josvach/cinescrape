import { describe, expect, it } from "vitest";

import { computeLive } from "./compute";
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
