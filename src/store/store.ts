import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { filmIdentity } from "@/core/match";

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
  mergeDuplicateFilms(state);
  return state;
}

/**
 * Join films that are the same release under two keys.
 *
 * Golden Apple publishes no original title, so its films were keyed on the
 * Czech one and could not meet the entry the other chains had keyed on the
 * original — "Spider-Man: Zbrusu nový den" and "Spider-Man: Brand New Day" sat
 * in the ranking as two films. `resolveFilm` no longer creates those, but the
 * pairs already in the state file have to be folded together, and the only copy
 * of that data is the file itself.
 *
 * The survivor is the lower id: it is the one the other chains, the alias map
 * and the ramp buckets already point at.
 */
export function mergeDuplicateFilms(state: State): number {
  const byCzech = new Map<string, number>();
  const remap = new Map<number, number>();

  for (const film of [...state.films].sort((a, b) => a.id - b.id)) {
    // This runs over whatever is on disk, including files written by versions
    // that stored less than the current shape.
    const czech = film.czechKey ?? (film.title ? filmIdentity(film.title, null).matchKey : null);
    if (!czech) continue;
    film.czechKey = czech;
    const keeper = byCzech.get(czech);
    if (keeper === undefined) {
      byCzech.set(czech, film.id);
      continue;
    }
    remap.set(film.id, keeper);
    const kept = state.films.find((f) => f.id === keeper)!;
    // Prefer whichever half knows the original title, so the merged film keeps
    // the stronger key for the next chain that arrives.
    if (!kept.originalTitle && film.originalTitle) {
      kept.originalTitle = film.originalTitle;
      kept.matchKey = film.matchKey;
      kept.tightKey = film.tightKey;
    }
    kept.articles ??= film.articles;
    kept.rating ??= film.rating;
  }

  if (remap.size === 0) return 0;

  state.films = state.films.filter((f) => !remap.has(f.id));
  for (const [alias, id] of Object.entries(state.filmAliases)) {
    if (remap.has(id)) state.filmAliases[alias] = remap.get(id)!;
  }
  for (const [titleId, id] of Object.entries(state.cineStarTitles)) {
    if (remap.has(id)) state.cineStarTitles[titleId] = remap.get(id)!;
  }
  for (const s of Object.values(state.screenings)) {
    if (remap.has(s.filmId)) s.filmId = remap.get(s.filmId)!;
  }
  for (const bucket of state.ramp) {
    for (const [from, to] of remap) {
      const moved = bucket.byFilm[String(from)];
      if (moved === undefined) continue;
      bucket.byFilm[String(to)] = (bucket.byFilm[String(to)] ?? 0) + moved;
      delete bucket.byFilm[String(from)];
    }
  }
  return remap.size;
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
