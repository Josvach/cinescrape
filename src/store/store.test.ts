import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadHistory, loadState, saveState } from "./store";
import { emptyState } from "./types";

const originalDataDir = process.env.DATA_DIR;

afterEach(() => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

async function withData(files: Record<string, unknown>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cinescrape-"));
  for (const [name, value] of Object.entries(files)) {
    await writeFile(join(dir, name), JSON.stringify(value));
  }
  process.env.DATA_DIR = dir;
  return dir;
}

describe("loadState", () => {
  it("starts empty when there is no file yet", async () => {
    await withData({});
    const state = await loadState();
    expect(state.films).toEqual([]);
    expect(state.nextFilmId).toBe(1);
  });

  it("fills in fields a older version never wrote", async () => {
    // Exactly what broke in the wild: a state file predating the CineStar
    // title cache made discovery throw on the first new screening.
    await withData({
      "state.json": {
        version: 1,
        updatedAt: "2026-07-31T10:00:00.000Z",
        cinemas: {},
        halls: {},
        films: [{ id: 3, matchKey: "a", tightKey: "a", title: "A", originalTitle: null }],
        filmAliases: {},
        screenings: {},
        ramp: [],
        nextFilmId: 4,
      },
    });

    const state = await loadState();
    expect(state.cineStarTitles).toEqual({});
    expect(() => state.cineStarTitles["10925"]).not.toThrow();
    // Existing data survives untouched.
    expect(state.films).toHaveLength(1);
    expect(state.nextFilmId).toBe(4);
  });

  it("rebuilds a missing id counter above every film in use", async () => {
    await withData({
      "state.json": { version: 1, films: [{ id: 7 }, { id: 12 }] },
    });
    // Reusing 1 here would quietly merge two different films.
    expect((await loadState()).nextFilmId).toBe(13);
  });

  it("refuses to start from scratch when the file is corrupt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cinescrape-"));
    await writeFile(join(dir, "state.json"), "{ truncated");
    process.env.DATA_DIR = dir;
    // Silently returning an empty state would erase history that cannot be
    // scraped again.
    await expect(loadState()).rejects.toThrow(/could not be parsed/);
  });

  it("round-trips through a save", async () => {
    await withData({});
    const state = emptyState();
    state.films.push({ id: 1, matchKey: "k", tightKey: "k", title: "T", originalTitle: null });
    await saveState(state);

    const reloaded = await loadState();
    expect(reloaded.films[0].title).toBe("T");
    expect(reloaded.updatedAt).toBeTruthy();
  });
});

describe("loadHistory", () => {
  it("tolerates a file missing its collections", async () => {
    await withData({ "history.json": { version: 1 } });
    const history = await loadHistory();
    expect(history.days).toEqual({});
    expect(history.films).toEqual({});
  });
});
