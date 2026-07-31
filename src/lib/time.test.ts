import { describe, expect, it } from "vitest";

import { businessDay, pragueDate, pragueToUtc } from "./time";

describe("pragueToUtc", () => {
  it("handles summer time (CEST, UTC+2)", () => {
    expect(pragueToUtc("2026-07-31 12:00").toISOString()).toBe("2026-07-31T10:00:00.000Z");
  });

  it("handles winter time (CET, UTC+1)", () => {
    expect(pragueToUtc("2026-01-15T20:30:00").toISOString()).toBe("2026-01-15T19:30:00.000Z");
  });

  it("accepts both the space and the T separator", () => {
    expect(pragueToUtc("2026-07-31 12:00").getTime()).toBe(
      pragueToUtc("2026-07-31T12:00:00").getTime(),
    );
  });

  it("resolves the hour after the spring-forward transition", () => {
    // Clocks jump 02:00 -> 03:00 on 2026-03-29; 03:00 local is already CEST.
    expect(pragueToUtc("2026-03-29T03:00:00").toISOString()).toBe("2026-03-29T01:00:00.000Z");
  });

  it("resolves an evening after the autumn transition", () => {
    // Clocks fall back on 2026-10-25; by the evening we are on CET.
    expect(pragueToUtc("2026-10-25T20:00:00").toISOString()).toBe("2026-10-25T19:00:00.000Z");
  });

  it("rejects input it cannot parse rather than guessing", () => {
    expect(() => pragueToUtc("31.7.2026 12:00")).toThrow();
  });
});

describe("businessDay", () => {
  it("keeps an evening screening on its own day", () => {
    expect(businessDay("2026-07-31 21:00")).toBe("2026-07-31");
  });

  it("counts an after-midnight screening towards the previous day", () => {
    expect(businessDay("2026-08-01 00:30")).toBe("2026-07-31");
    expect(businessDay("2026-08-01 04:59")).toBe("2026-07-31");
  });

  it("starts the new day at the cutoff", () => {
    expect(businessDay("2026-08-01 05:00")).toBe("2026-08-01");
  });

  it("rolls back across a month boundary", () => {
    expect(businessDay("2026-01-01 01:00")).toBe("2025-12-31");
  });
});

describe("pragueDate", () => {
  it("reports the Prague calendar day for an instant", () => {
    // 23:30 UTC in July is already the next day in Prague.
    expect(pragueDate(new Date("2026-07-31T23:30:00Z"))).toBe("2026-08-01");
  });
});
