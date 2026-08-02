import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { readXls } from "@/lib/xls";

import { parseAnnual, parseAnnualFileName, parseFileName, parseWeek } from "./ufd";

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

const annualSheet = readXls(
  readFileSync(fileURLToPath(new URL("./__fixtures__/ufd-top50-2024.xls", import.meta.url))),
);

describe("parseAnnual", () => {
  const annual = parseAnnual(annualSheet, 2024);

  it("reads the whole top 50", () => {
    expect(annual.rows).toHaveLength(50);
    expect(annual.year).toBe(2024);
  });

  it("reads lifetime totals, not the calendar year", () => {
    // Aristokratka premiered in 2023, so its run reaches past what 2024 alone
    // shows: 305 232 in the year, 309 277 since release. Reading the wrong
    // column here is exactly the undercount these files exist to fix.
    const aristokratka = annual.rows.find((r) => r.title.startsWith("Aristokratka"))!;
    expect(aristokratka.admissions).toBe(309277);
    expect(aristokratka.screenings).toBe(8083);
  });

  it("reads the headline films", () => {
    expect(annual.rows[0]).toMatchObject({ rank: 1, title: "Vlny", admissions: 885767 });
    expect(annual.rows[1].originalTitle).toBe("Inside Out 2");
  });

  it("converts the premiere from its serial date", () => {
    expect(annual.rows[0].premiere).toBe("2024-08-15");
    expect(annual.rows[1].premiere).toBe("2024-07-18");
  });

  it("refuses a sheet without the lifetime block", () => {
    const stripped = annualSheet.map((row) =>
      row.map((c) => (typeof c === "string" && /od prem/i.test(c) ? null : c)),
    );
    expect(() => parseAnnual(stripped, 2024)).toThrow(/lifetime/);
  });
});

describe("parseAnnualFileName", () => {
  it("reads the year", () => {
    expect(parseAnnualFileName("https://www.ufd.cz/files/article/1516/top502024.xls")).toBe(2024);
    expect(parseAnnualFileName("top20-2026-30cz.xls")).toBeNull();
  });
});
