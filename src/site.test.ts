import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const html = readFileSync(fileURLToPath(new URL("../site/index.html", import.meta.url)), "utf8");

/**
 * The dashboard is a hand-written page with no build step, so nothing would
 * otherwise catch a syntax error in it — a stray paren shipped a blank page
 * that only a browser would have complained about. This parses it the same way
 * the browser will.
 */
describe("site/index.html", () => {
  const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1];

  it("has an inline module", () => {
    expect(script).toBeTruthy();
  });

  it("parses as JavaScript", () => {
    const file = join(mkdtempSync(join(tmpdir(), "cinescrape-site-")), "page.mjs");
    writeFileSync(file, script!);
    expect(() => execFileSync(process.execPath, ["--check", file])).not.toThrow();
  });

  it("only fetches its own data file", () => {
    // A strict-CSP host and an offline phone both punish an external request.
    const urls = script!.match(/fetch\(\s*[`"'][^`"']+/g) ?? [];
    expect(urls.every((u) => !/https?:/.test(u))).toBe(true);
  });

  it("declares the icon and manifest the home-screen install needs", () => {
    expect(html).toContain('rel="manifest"');
    expect(html).toContain('name="apple-mobile-web-app-capable"');
  });

  it("stays out of search indexes", () => {
    expect(html).toMatch(/name="robots"\s+content="noindex/);
  });
});
