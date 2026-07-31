import { describe, expect, it } from "vitest";

import { shouldRecordSnapshot } from "./schedule";

const now = new Date("2026-07-31T10:00:00Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const at = (ms: number) => new Date(now.getTime() + ms);

const base = {
  previousSeatsSold: 40,
  seatsSold: 40,
  lastCapturedAt: at(-5 * MINUTE),
  startsAt: at(30 * HOUR),
  now,
};

describe("shouldRecordSnapshot", () => {
  it("always keeps the first reading of a screening", () => {
    expect(
      shouldRecordSnapshot({ ...base, previousSeatsSold: null, lastCapturedAt: null }),
    ).toBe(true);
  });

  it("skips a reading that has not moved", () => {
    // This is the case that would otherwise write ~3300 useless rows per run.
    expect(shouldRecordSnapshot(base)).toBe(false);
  });

  it("keeps every change close to showtime", () => {
    expect(
      shouldRecordSnapshot({ ...base, seatsSold: 41, startsAt: at(3 * HOUR) }),
    ).toBe(true);
  });

  it("throttles changes a day or two out", () => {
    const changed = { ...base, seatsSold: 41, startsAt: at(30 * HOUR) };
    expect(shouldRecordSnapshot({ ...changed, lastCapturedAt: at(-5 * MINUTE) })).toBe(false);
    expect(shouldRecordSnapshot({ ...changed, lastCapturedAt: at(-20 * MINUTE) })).toBe(true);
  });

  it("throttles changes far in the future harder", () => {
    const changed = { ...base, seatsSold: 41, startsAt: at(20 * 24 * HOUR) };
    expect(shouldRecordSnapshot({ ...changed, lastCapturedAt: at(-30 * MINUTE) })).toBe(false);
    expect(shouldRecordSnapshot({ ...changed, lastCapturedAt: at(-70 * MINUTE) })).toBe(true);
  });

  it("never throttles inside the final capture window", () => {
    // The reading that becomes the permanent admissions figure is written even
    // if nothing changed and the previous one was seconds ago.
    expect(
      shouldRecordSnapshot({
        ...base,
        lastCapturedAt: at(-30_000),
        startsAt: at(10 * MINUTE),
      }),
    ).toBe(true);
  });

  it("keeps history for a screening that already started", () => {
    expect(shouldRecordSnapshot({ ...base, startsAt: at(-HOUR) })).toBe(true);
  });
});
