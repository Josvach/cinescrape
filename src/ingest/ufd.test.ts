import { describe, expect, it } from "vitest";

import { emptyHistory } from "@/store/types";

import { expectedLatestWeekend, isAwaitingReport, latestTotals, weekKey } from "./ufd";

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
