import { describe, expect, it } from "vitest";

import { emptyHistory } from "@/store/types";

import {
  allTimeRanking,
  byWeekDescending,
  expectedLatestWeekend,
  isAwaitingReport,
  latestTotals,
  weekKey,
} from "./ufd";

const at = (iso: string) => new Date(`${iso}T10:00:00Z`);

describe("expectedLatestWeekend", () => {
  it("points at the weekend that just ended, on the Monday it is published", () => {
    // UFD weekends run Thursday to Sunday; Monday 3.8. reports the 30.7. weekend.
    expect(expectedLatestWeekend(at("2026-08-03"))).toBe("2026-07-30");
  });

  it("keeps pointing there for the rest of the week", () => {
    expect(expectedLatestWeekend(at("2026-08-05"))).toBe("2026-07-30");
    expect(expectedLatestWeekend(at("2026-08-08"))).toBe("2026-07-30");
  });

  it("does not expect a report for a weekend still running", () => {
    // Sunday 2.8. is mid-weekend, so the last complete one is still 23.7.
    expect(expectedLatestWeekend(at("2026-08-02"))).toBe("2026-07-23");
    expect(expectedLatestWeekend(at("2026-07-31"))).toBe("2026-07-23");
  });
});

describe("isAwaitingReport", () => {
  const withWeekend = (weekendFrom: string) => {
    const history = emptyHistory();
    history.ufd = {
      [weekKey(2026, 30)]: { year: 2026, week: 30, weekendFrom, entries: [] },
    };
    return history;
  };

  it("waits when a finished weekend has no report yet", () => {
    // Monday morning: 30.7. weekend is over, we still only have 23.7.
    expect(isAwaitingReport(withWeekend("2026-07-23"), at("2026-08-03"))).toBe(true);
  });

  it("stops once the report lands", () => {
    expect(isAwaitingReport(withWeekend("2026-07-30"), at("2026-08-03"))).toBe(false);
  });

  it("does not wait mid-weekend", () => {
    expect(isAwaitingReport(withWeekend("2026-07-23"), at("2026-08-02"))).toBe(false);
  });

  it("waits when there is nothing at all", () => {
    expect(isAwaitingReport(emptyHistory(), at("2026-08-03"))).toBe(true);
  });
});

describe("byWeekDescending", () => {
  it("orders by the week number, not by the file name", () => {
    // The week is not zero-padded, so a string sort reads week 9 as newer than
    // week 30 — on the Monday a report is due that fetches March instead of
    // this weekend.
    const files = ["top20-2026-9cz.xls", "top20-2026-30cz.xls", "top20-2026-28cz.xls"];
    expect([...files].sort(byWeekDescending)).toEqual([
      "top20-2026-30cz.xls",
      "top20-2026-28cz.xls",
      "top20-2026-9cz.xls",
    ]);
  });

  it("puts a newer year ahead of a higher week number", () => {
    expect(["top20-2025-52cz.xls", "top20-2026-1cz.xls"].sort(byWeekDescending)[0]).toBe(
      "top20-2026-1cz.xls",
    );
  });
});

describe("latestTotals", () => {
  it("takes the highest run total, which is the most recent one", () => {
    const history = emptyHistory();
    history.ufd = {
      "2026-W28": {
        year: 2026, week: 28, weekendFrom: "2026-07-09",
        entries: [{ rank: 1, title: "Odyssea", distributor: "", weekOfRun: 1, cinemas: 200,
          weekendAdmissions: 100, weekendGross: 0, totalAdmissions: 100, totalGross: 10, filmId: 8 }],
      },
      "2026-W30": {
        year: 2026, week: 30, weekendFrom: "2026-07-23",
        entries: [{ rank: 1, title: "Odyssea", distributor: "", weekOfRun: 2, cinemas: 161,
          weekendAdmissions: 86017, weekendGross: 0, totalAdmissions: 256291, totalGross: 60, filmId: 8 }],
      },
    };
    // A film that dropped out of the top 20 and came back must not regress to
    // an older, smaller total.
    expect(latestTotals(history).get(8)).toMatchObject({
      admissions: 256291,
      weekendFrom: "2026-07-23",
    });
  });

  it("ignores entries we could not match to a film", () => {
    const history = emptyHistory();
    history.ufd = {
      "2026-W30": {
        year: 2026, week: 30, weekendFrom: "2026-07-23",
        entries: [{ rank: 1, title: "Něco starého", distributor: "", weekOfRun: 9, cinemas: 3,
          weekendAdmissions: 10, weekendGross: 0, totalAdmissions: 20, totalGross: 0 }],
      },
    };
    expect(latestTotals(history).size).toBe(0);
  });
});

describe("allTimeRanking", () => {
  const weekly = (title: string, weekendFrom: string, totalAdmissions: number) => ({
    year: Number(weekendFrom.slice(0, 4)),
    week: 1,
    weekendFrom,
    entries: [
      {
        rank: 1, title, distributor: "", weekOfRun: 1, cinemas: 100,
        weekendAdmissions: 0, weekendGross: 0, totalAdmissions, totalGross: 0,
      },
    ],
  });

  const annual = (title: string, year: number, admissions: number, premiere: string | null) => ({
    year,
    entries: [
      { rank: 1, title, originalTitle: "", distributor: "", premiere, admissions, gross: 0, screenings: 0 },
    ],
  });

  it("prefers the annual lifetime total over the last weekly figure", () => {
    // The weeklies stop reporting a film once it leaves the top 20, so its
    // largest weekly total is where it was on the way down — 305 232 against
    // the 309 277 the annual file says it finished on.
    const history = emptyHistory();
    history.ufd = { "2024-W01": weekly("Aristokratka", "2024-01-04", 305_232) };
    history.ufdAnnual = { "2024": annual("Aristokratka", 2024, 309_277, "2023-12-21") };
    expect(allTimeRanking(history)[0].admissions).toBe(309_277);
  });

  it("dates a film by its premiere, not by the first week we saw it", () => {
    // Without the annual premiere date, a re-release in 2020 would date
    // Bohemian Rhapsody to 2020.
    const history = emptyHistory();
    history.ufd = { "2020-W01": weekly("Bohemian Rhapsody", "2020-01-02", 1_831_714) };
    history.ufdAnnual = { "2018": annual("Bohemian Rhapsody", 2018, 1_500_000, "2018-11-01") };
    expect(allTimeRanking(history)[0]).toMatchObject({ year: 2018, admissions: 1_831_714 });
  });

  it("includes films the weeklies never covered", () => {
    const history = emptyHistory();
    history.ufdAnnual = { "2017": annual("Po strništi bos", 2017, 511_000, "2017-08-17") };
    expect(allTimeRanking(history)).toHaveLength(1);
  });
});
