import { describe, expect, it } from "vitest";

import { normalizeFormats } from "./formats";

describe("normalizeFormats", () => {
  it("keeps presentation formats and drops projector, sound and seating tags", () => {
    // A real Cinema City attribute list.
    expect(normalizeFormats(["laser-barco", "atmos", "4dx", "3d", "comfort"])).toEqual([
      "3D",
      "4DX",
    ]);
  });

  it("drops CineStar's marketing properties", () => {
    expect(normalizeFormats(["Premiéra", "4K", "Titulky", "HIT", "Premium"])).toEqual([]);
  });

  it("recognises the rarer formats", () => {
    expect(normalizeFormats(["imax"])).toEqual(["IMAX"]);
    expect(normalizeFormats(["70mm"])).toEqual(["70mm"]);
  });

  it("is case-insensitive and de-duplicates", () => {
    expect(normalizeFormats(["3D", "3d", " 3d "])).toEqual(["3D"]);
  });

  it("handles nothing at all", () => {
    expect(normalizeFormats(null)).toEqual([]);
    expect(normalizeFormats([])).toEqual([]);
  });
});
