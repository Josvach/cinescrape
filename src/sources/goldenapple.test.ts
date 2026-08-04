import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseProgramme, readOccupancy } from "./goldenapple";

const read = (name: string) =>
  readFileSync(fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url)), "utf8");

const programme = parseProgramme(read("goldenapple-programme.html"));

describe("parseProgramme", () => {
  it("reads every screening on the page", () => {
    // 2 left today plus three full days, and one show at the second venue.
    expect(programme).toHaveLength(87);
  });

  it("dates each screening from the day tab it sits under", () => {
    const days = [...new Set(programme.map((s) => s.day))].sort();
    expect(days).toEqual(["2026-08-02", "2026-08-03", "2026-08-04", "2026-08-05"]);
  });

  it("reads title, hall and showtime", () => {
    const first = programme[0];
    expect(first).toMatchObject({
      screeningId: "161487",
      day: "2026-08-02",
      time: "20:45",
      venue: "Multikino",
      hall: "Sál 4",
      version: "TIT",
    });
    expect(first.film).toEqual({ externalId: "10515", title: "Posedlost" });
  });

  it("converts Prague wall-clock to an instant", () => {
    // 20:45 in CEST is 18:45 UTC; getting this wrong shifts a whole day's
    // admissions into the wrong bucket.
    expect(programme[0].startsAt.toISOString()).toBe("2026-08-02T18:45:00.000Z");
  });

  it("keeps the second venue apart from the multiplex", () => {
    const male = programme.filter((s) => s.venue === "Malé kino");
    expect(male).toHaveLength(1);
    expect(male[0].hall).toBe("Malé kino");
    expect(male[0].film.title).toBe("Ďábel nosí Pradu 2");
  });

  it("drops the programme strand from the title", () => {
    // The link wraps "filmový klub seniorů" inside the anchor.
    expect(programme.every((s) => !/klub|anime/i.test(s.film.title))).toBe(true);
  });

  it("reads technologies but not the running time", () => {
    const fourK = programme.find((s) => s.screeningId === "161439")!;
    expect(fourK.attributes).toEqual(["4K"]);
    expect(programme.every((s) => s.attributes.every((a) => !/minut/.test(a)))).toBe(true);
  });

  it("returns nothing for a page it cannot recognise", () => {
    expect(parseProgramme("<html><body>nic</body></html>")).toEqual([]);
  });
});

describe("readOccupancy", () => {
  const occ = readOccupancy(read("goldenapple-seating.html"));

  it("counts taken and total seats", () => {
    expect(occ).toMatchObject({ seatsSold: 21, seatsTotal: 95 });
  });

  it("reads the price from the free seats", () => {
    expect(occ.priceMin).toBe(219);
    expect(occ.priceMax).toBe(219);
  });

  it("reports an empty plan rather than an empty hall", () => {
    // A closed screening answers with markup but no seats; the caller turns
    // this into "stop polling", not into "nobody came".
    expect(readOccupancy("<div>Predaj ukonceny</div>")).toMatchObject({
      seatsSold: 0,
      seatsTotal: 0,
      sellable: false,
    });
  });

  it("marks a plan with no free seat as unsellable", () => {
    // Once sales close every seat is greyed out, which is indistinguishable
    // from a sell-out in the markup alone — the flag is what lets the caller
    // apply the one thing that does tell them apart, the clock.
    const shut = read("goldenapple-seating.html").replace(
      /<g class="seat-item"/g,
      '<g class="seat-item occupied"',
    );
    expect(readOccupancy(shut)).toMatchObject({ seatsSold: 95, seatsTotal: 95, sellable: false });
    expect(occ.sellable).toBe(true);
  });
});
