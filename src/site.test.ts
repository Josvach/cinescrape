import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const html = readFileSync(fileURLToPath(new URL("../site/index.html", import.meta.url)), "utf8");
const script = readFileSync(fileURLToPath(new URL("../site/app.js", import.meta.url)), "utf8");

/**
 * The dashboard is a hand-written page with no build step, so nothing would
 * otherwise catch a syntax error in it — a stray paren shipped a blank page
 * that only a browser would have complained about. This parses it the same way
 * the browser will.
 */
describe("site/index.html", () => {
  it("loads its module", () => {
    expect(html).toContain('src="app.js"');
    expect(script.length).toBeGreaterThan(1000);
  });

  it("parses as JavaScript", () => {
    const file = join(mkdtempSync(join(tmpdir(), "cinescrape-site-")), "page.mjs");
    writeFileSync(file, script);
    expect(() => execFileSync(process.execPath, ["--check", file])).not.toThrow();
  });

  it("ships a service worker that parses", () => {
    // The worker delivers the film-admission notifications and has no build
    // step either, so a stray syntax error would only surface on a phone.
    const sw = readFileSync(fileURLToPath(new URL("../site/sw.js", import.meta.url)), "utf8");
    const file = join(mkdtempSync(join(tmpdir(), "cinescrape-sw-")), "sw.js");
    writeFileSync(file, sw);
    expect(() => execFileSync(process.execPath, ["--check", file])).not.toThrow();
    expect(script).toContain('register("sw.js"');
  });

  it("only fetches its own data file", () => {
    // A strict-CSP host and an offline phone both punish an external request.
    const urls = script.match(/fetch\(\s*[`"'][^`"']+/g) ?? [];
    expect(urls.every((u) => !/https?:/.test(u))).toBe(true);
  });

  it("has the bottom navigation the whole layout depends on", () => {
    expect(html).toContain('id="nav"');
    for (const tab of ["Dnes", "Týden", "Celkově"]) expect(script).toContain(tab);
  });

  it("declares the icon and manifest the home-screen install needs", () => {
    expect(html).toContain('rel="manifest"');
    expect(html).toContain('name="apple-mobile-web-app-capable"');
  });

  it("stays out of search indexes", () => {
    expect(html).toMatch(/name="robots"\s+content="noindex/);
  });

  it("lets the publish step cache-bust the script", () => {
    // Pages serves app.js with a max-age, so a plain <script src="app.js">
    // leaves a phone that already opened the page running the old code — it
    // showed a removed version string and a removed tile for hours. publish.sh
    // rewrites this exact string, so the two have to keep matching.
    expect(html).toContain('src="app.js"');
    const publish = readFileSync(fileURLToPath(new URL("../scripts/publish.sh", import.meta.url)), "utf8");
    expect(publish).toContain('src=\\"app.js\\"');
  });

  it("shows a build version, and styles it", () => {
    // The version exists so a screenshot can be pinned to a build; one that is
    // declared but never rendered, or rendered with no rule behind it, would
    // quietly stop doing that.
    expect(script).toMatch(/const VERSION = "[^"]+"/);
    expect(script).toContain('class: "version"');
    expect(html).toContain(".topbar .version");
  });
});
