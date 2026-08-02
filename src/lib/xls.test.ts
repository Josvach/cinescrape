import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { readXls } from "./xls";

const fixture = readFileSync(
  fileURLToPath(new URL("../sources/__fixtures__/ufd-top20-2026-30.xls", import.meta.url)),
);

describe("readXls", () => {
  const sheet = readXls(fixture);

  it("reads the grid", () => {
    expect(sheet.length).toBe(26);
    expect(sheet[0].length).toBe(16);
  });

  it("decodes shared strings with Czech diacritics", () => {
    expect(sheet[1][0]).toBe("ČESKÁ REPUBLIKA TOP 20");
    expect(sheet[6][2]).toBe("Odyssea");
    expect(sheet[9][2]).toBe("Odvážná Vaiana");
    expect(sheet[7][3]).toBe("BONTONFILM a.s.");
  });

  it("decodes integers", () => {
    // Odyssea: weekend admissions, then the whole run.
    expect(sheet[6][9]).toBe(86017);
    expect(sheet[6][15]).toBe(256291);
    expect(sheet[6][0]).toBe(1);
  });

  it("decodes RK-encoded fractions", () => {
    // Gross figures carry halves; a wrong RK decode shows up here first.
    expect(sheet[8][8]).toBe(3868681.5);
    expect(sheet[8][14]).toBe(50035450.75);
  });

  it("decodes negative and small fractions", () => {
    expect(sheet[6][10]).toBeCloseTo(-0.172, 4);
    expect(sheet[7][10]).toBeCloseTo(56.2055, 4);
  });

  it("keeps the header row addressable", () => {
    expect(sheet[4][2]).toBe("Film");
    expect(sheet[4][8]).toBe("Víkend");
    expect(sheet[4][14]).toBe("Celkem");
  });

  it("leaves empty cells null rather than guessing", () => {
    expect(sheet[3].every((c) => c === null)).toBe(true);
  });

  it("rejects something that is not a compound file", () => {
    expect(() => readXls(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toThrow(/OLE2/);
  });
});
