import { describe, expect, it } from "vitest";

import { emptyState } from "@/store/types";

import { markAlternativeProgramme } from "./cinestar";

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
