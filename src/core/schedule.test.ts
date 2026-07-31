import { describe, expect, it } from "vitest";

import { nextPollAt, settleConfidence } from "./schedule";

const now = new Date("2026-07-31T10:00:00Z");
const at = (offsetMs: number) => new Date(now.getTime() + offsetMs);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe("nextPollAt", () => {
  it("drops a past screening out of the queue", () => {
    expect(nextPollAt(at(-MINUTE), now)).toBeNull();
    expect(nextPollAt(now, now)).toBeNull();
  });

  it("polls every 10 minutes inside the last two hours", () => {
    expect(nextPollAt(at(90 * MINUTE), now)!.toISOString()).toBe("2026-07-31T10:10:00.000Z");
  });

  it("backs off for later today, tomorrow and beyond", () => {
    expect(nextPollAt(at(6 * HOUR), now)!.getTime() - now.getTime()).toBe(30 * MINUTE);
    expect(nextPollAt(at(30 * HOUR), now)!.getTime() - now.getTime()).toBe(2 * HOUR);
    expect(nextPollAt(at(10 * 24 * HOUR), now)!.getTime() - now.getTime()).toBe(12 * HOUR);
  });

  it("pulls the last poll back to just before showtime", () => {
    // Without the clamp the 10-minute cadence would next fire after the show
    // started, and the final admissions figure would be lost for good.
    const startsAt = at(8 * MINUTE);
    expect(nextPollAt(startsAt, now)!.toISOString()).toBe("2026-07-31T10:03:00.000Z");
  });

  it("polls immediately when showtime is already inside the capture target", () => {
    const startsAt = at(2 * MINUTE);
    expect(nextPollAt(startsAt, now)!.getTime()).toBe(now.getTime());
  });

  it("never schedules a poll after the screening has started", () => {
    for (const minutes of [1, 3, 5, 9, 30, 119, 200, 3000]) {
      const startsAt = at(minutes * MINUTE);
      const next = nextPollAt(startsAt, now)!;
      expect(next.getTime()).toBeLessThan(startsAt.getTime());
    }
  });
});

describe("settleConfidence", () => {
  const startsAt = new Date("2026-07-31T18:00:00Z");

  it("marks a screening we never captured as missed", () => {
    expect(settleConfidence(startsAt, null)).toBe("missed");
  });

  it("marks a snapshot inside the window as final", () => {
    expect(settleConfidence(startsAt, new Date("2026-07-31T17:50:00Z"))).toBe("final");
    expect(settleConfidence(startsAt, new Date("2026-07-31T17:45:00Z"))).toBe("final");
  });

  it("marks an older snapshot as partial", () => {
    expect(settleConfidence(startsAt, new Date("2026-07-31T16:00:00Z"))).toBe("partial");
  });

  it("treats a snapshot taken after the start as final", () => {
    expect(settleConfidence(startsAt, new Date("2026-07-31T18:05:00Z"))).toBe("final");
  });
});
