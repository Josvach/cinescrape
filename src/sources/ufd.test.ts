import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { readXls } from "@/lib/xls";

import { parseFileName, parseWeek } from "./ufd";

const sheet = readXls(
  readFileSync(fileURLToPath(new URL("./__fixtures__/ufd-top20-2026-30.xls", import.meta.url))),
);

describe("parseFileName", () => {
  it("reads the year and week", () => {
    expect(parseFileName("https://www.ufd.cz/files/article/1567/top20-2026-30cz.xls")).toEqual({
      year: 2026,
      week: 30,
    });
    expect(parseFileName("top20-2021-04cz.xls")).toEqual({ year: 2021, week: 4 });
  });

  it("rejects anything else", () => {
    expect(parseFileName("https://www.ufd.cz/files/plan-premier.pdf")).toBeNull();
  });
});

describe("parseWeek", () => {
  const week = parseWeek(sheet, { year: 2026, week: 30 });

  it("reads the weekend the report covers", () => {
    expect(week.weekendFrom).toBe("2026-07-23");
  });

  it("reads all twenty films", () => {
    expect(week.rows).toHaveLength(20);
    expect(week.rows[0].rank).toBe(1);
    expect(week.rows[19].rank).toBe(20);
  });

  it("separates the weekend from the whole run", () => {
    // This distinction is the entire point of the file: 86k over the weekend,
    // 256k since release.
    const odyssea = week.rows[0];
    expect(odyssea.title).toBe("Odyssea");
    expect(odyssea.weekendAdmissions).toBe(86017);
    expect(odyssea.totalAdmissions).toBe(256291);
    expect(odyssea.weekendGross).toBe(21024022);
    expect(odyssea.totalGross).toBe(60659046);
  });

  it("reads the release week and cinema count", () => {
    expect(week.rows[0].weekOfRun).toBe(2);
    expect(week.rows[0].cinemas).toBe(161);
    expect(week.rows[1].weekOfRun).toBe(1);
  });

  it("reads distributor and country", () => {
    expect(week.rows[0].distributor).toBe("Cinemart, a.s.");
    expect(week.rows[1].country).toBe("CZE");
  });

  it("stops at the end of the ranking rather than reading footer lines", () => {
    expect(week.rows.every((r) => r.title && r.rank >= 1 && r.rank <= 20)).toBe(true);
  });

  it("locates columns by header text, not by position", () => {
    // A file that gained a column would otherwise shift every figure silently.
    const shifted = sheet.map((row) => [...row.slice(0, 5), null, ...row.slice(5)]);
    const parsed = parseWeek(shifted, { year: 2026, week: 30 });
    expect(parsed.rows[0].weekendAdmissions).toBe(86017);
    expect(parsed.rows[0].totalAdmissions).toBe(256291);
  });

  it("refuses a sheet it cannot recognise", () => {
    expect(() => parseWeek([[null, null, "něco jiného"]], { year: 2026, week: 1 })).toThrow(
      /header/,
    );
  });
});
