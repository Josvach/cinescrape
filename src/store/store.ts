import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { emptyHistory, emptyState, type History, type State } from "./types";

/** Where the JSON lives. Overridable so tests can use a scratch directory. */
export const dataDir = () => process.env.DATA_DIR ?? "data";

const statePath = () => join(dataDir(), "state.json");
const historyPath = () => join(dataDir(), "history.json");
const livePath = () => join(dataDir(), "live.json");

async function readJson<T>(path: string, fallback: () => T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (err) {
    // A missing file is the first run. Anything else — a truncated write, bad
    // JSON — must not be silently replaced with an empty dataset, or one bad
    // run would erase history that cannot be re-scraped.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return fallback();
    throw new Error(`${path} exists but could not be parsed: ${String(err)}`);
  }
}

/**
 * Write via a temporary file and rename.
 *
 * A run killed mid-write (GitHub cancels jobs) would otherwise leave truncated
 * JSON, and the next run would refuse to start. Rename is atomic on the same
 * filesystem, so the file on disk is always a complete previous or next version.
 */
async function writeJson(path: string, value: unknown, pretty: boolean): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, pretty ? 1 : 0));
  await rename(tmp, path);
}

/**
 * Fill in anything a state file written by an older version is missing.
 *
 * The data is the only copy — it cannot be re-scraped — so it is carried
 * forward across format changes rather than reset. Skipping this is not a
 * theoretical risk: adding the CineStar title cache made the next run crash on
 * the first newly listed screening, because the field simply was not there.
 */
function normalizeState(state: State): State {
  state.cinemas ??= {};
  state.halls ??= {};
  state.films ??= [];
  state.filmAliases ??= {};
  state.cineStarTitles ??= {};
  state.screenings ??= {};
  state.ramp ??= [];
  if (!Number.isInteger(state.nextFilmId)) {
    // Never reuse an id: a collision would silently merge two films.
    state.nextFilmId = state.films.reduce((max, f) => Math.max(max, f.id), 0) + 1;
  }
  return state;
}

function normalizeHistory(history: History): History {
  history.days ??= {};
  history.films ??= {};
  return history;
}

export const loadState = async () => normalizeState(await readJson<State>(statePath(), emptyState));
export const loadHistory = async () =>
  normalizeHistory(await readJson<History>(historyPath(), emptyHistory));

export async function saveState(state: State): Promise<void> {
  state.updatedAt = new Date().toISOString();
  // Compact: this file is machine-read only and is rewritten every few minutes.
  await writeJson(statePath(), state, false);
}

export const saveHistory = (history: History) => writeJson(historyPath(), history, false);

/** The only file the dashboard fetches. */
export const saveLive = (live: unknown) => writeJson(livePath(), live, false);
