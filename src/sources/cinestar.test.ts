import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import eventFixture from "./__fixtures__/cinestar-event.json";
import hallFixture from "./__fixtures__/cinestar-hall.json";
import {
  normalizeEvent,
  parseProgramme,
  readOccupancy,
  splitVersion,
  type CsEvent,
  type CsHall,
} from "./cinestar";

const programmeHtml = readFileSync(
  fileURLToPath(new URL("./__fixtures__/cinestar-program.html", import.meta.url)),
  "utf8",
);

describe("readOccupancy", () => {
  it("counts occupied seats on a real hall", () => {
    // Spider-Man 15:50, Sál 3 — hand-counted from the captured response.
    const occ = readOccupancy(hallFixture as unknown as CsHall);
    expect(occ.seatsTotal).toBe(217);
    expect(occ.seatsSold).toBe(139);
  });

  it("extracts the price range", () => {
    const occ = readOccupancy(hallFixture as unknown as CsHall);
    expect(occ.priceMin).toBe(249);
    expect(occ.priceMax).toBe(269);
  });

  it("counts an unrecognised state as sold rather than free", () => {
    const hall: CsHall = {
      seats: [
        { state: "FREE", row: "A", seat: 1 },
        { state: "RESERVED", row: "A", seat: 2 },
        { state: "OCCUPIED", row: "A", seat: 3 },
      ],
      prices: null,
    };
    expect(readOccupancy(hall)).toMatchObject({ seatsTotal: 3, seatsSold: 2 });
  });

  it("excludes unsellable seats from capacity", () => {
    const hall: CsHall = {
      seats: [
        { state: "FREE", row: "A", seat: 1 },
        { state: "BROKEN", row: "A", seat: 2 },
        { state: "OCCUPIED", row: "A", seat: 3 },
      ],
      prices: null,
    };
    expect(readOccupancy(hall)).toMatchObject({ seatsTotal: 2, seatsSold: 1 });
  });

  it("survives an empty hall payload", () => {
    expect(readOccupancy({ seats: null, prices: null })).toEqual({
      seatsSold: 0,
      seatsTotal: 0,
      priceMin: null,
      priceMax: null,
    });
  });
});

describe("parseProgramme", () => {
  it("pulls scheduled events out of the Nuxt payload", () => {
    const events = parseProgramme(programmeHtml);
    expect(events.length).toBeGreaterThan(300);

    const known = events.find((e) => e.eventId === "1742965");
    expect(known).toBeDefined();
    // The programme payload carries a real UTC offset, unlike event/get.
    expect(known!.startsAt.toISOString()).toBe("2026-07-31T08:00:00.000Z");
    expect(known!.objectId).toBe("628");
  });

  it("returns unique event ids", () => {
    const events = parseProgramme(programmeHtml);
    expect(new Set(events.map((e) => e.eventId)).size).toBe(events.length);
  });

  it("returns nothing rather than throwing on an unexpected page", () => {
    expect(parseProgramme("<html><body>nope</body></html>")).toEqual([]);
    expect(parseProgramme('<script type="application/json" id="__NUXT_DATA__">{bad</script>')).toEqual(
      [],
    );
  });
});

describe("splitVersion", () => {
  it("separates the version marker from the film title", () => {
    expect(splitVersion("Spider-Man: Zbrusu nový den TITULKY")).toEqual({
      title: "Spider-Man: Zbrusu nový den",
      languageVersion: "titulky",
    });
    expect(splitVersion("Odyssea DABING")).toEqual({
      title: "Odyssea",
      languageVersion: "dabing",
    });
  });

  it("leaves a plain title alone", () => {
    expect(splitVersion("Odyssea")).toEqual({ title: "Odyssea", languageVersion: null });
  });
});

describe("normalizeEvent", () => {
  it("maps an event onto our domain shape", () => {
    const n = normalizeEvent(eventFixture as unknown as CsEvent);

    expect(n.chain).toBe("cinestar");
    expect(n.externalId).toBe("1744000");
    expect(n.cinema.externalId).toBe("2");
    expect(n.hall.externalId).toBe("597");
    // title_groupid, not titleid — it merges the dubbed and subtitled variants.
    expect(n.film.externalId).toBe("10572");
    expect(n.film.title).toBe("Spider-Man: Zbrusu nový den");
    expect(n.film.originalTitle).toBe("Spider-Man: Brand New Day");
    expect(n.languageVersion).toBe("titulky");
  });

  it("reads event/get's naive timestamp as Prague time", () => {
    // 15:50 Prague in July is CEST, so 13:50 UTC.
    const n = normalizeEvent(eventFixture as unknown as CsEvent);
    expect(n.startsAt.toISOString()).toBe("2026-07-31T13:50:00.000Z");
  });

  it("drops marketing and amenity tags from the format list", () => {
    // The fixture carries Premiéra, 4K, Titulky, HIT, Premium — none of which
    // is a presentation format, so this screening is a plain 2D showing.
    const n = normalizeEvent(eventFixture as unknown as CsEvent);
    expect(n.formatAttrs).toEqual([]);
  });
});
