/**
 * Folding the official weekly results into our history.
 *
 * The rule the whole product hangs on: **UFD owns the past, scraping owns
 * today.** Up to the last published Monday, a film's admissions are whatever
 * the association reported — national, complete, and the figure anyone in the
 * industry will recognise. From that Monday forward the number is ours, measured
 * across the chains we can reach, and clearly a live estimate.
 *
 * Mixing the two any other way produces a figure that is neither.
 */

import { filmIdentity } from "@/core/match";
import { rateLimited } from "@/lib/http";
import { pragueDate } from "@/lib/time";
import {
  fetchAnnual,
  fetchAnnualFileUrls,
  fetchArticleUrls,
  fetchWeek,
  fetchWeekFileUrls,
  parseAnnualFileName,
  parseFileName,
  type UfdWeek,
} from "@/sources/ufd";
import type { WeekendPoint } from "@/stats/forecast";
import type { History, State, UfdEntry } from "@/store/types";

/** How often to look for a new weekly report when we are already up to date. */
const REFRESH_AFTER_HOURS = 12;

/**
 * How often to look while a report we expect is still missing.
 *
 * UFD publishes on Monday, usually late morning. Waiting half a day to notice
 * would mean the weekend's official numbers sit unseen for most of the day they
 * arrive, so once a weekend has passed without a report the check runs on
 * almost every iteration. It costs one index page and one article fetch.
 */
const WAITING_INTERVAL_MINUTES = 10;

/**
 * The weekend UFD should have published by now, as `YYYY-MM-DD`.
 *
 * Their weekends run Thursday to Sunday, so the most recently completed one
 * opened three days before the last Sunday that has fully passed.
 */
export function expectedLatestWeekend(now: Date = new Date()): string {
  const d = new Date(`${pragueDate(now)}T12:00:00Z`);
  const dayOfWeek = d.getUTCDay();
  // On Sunday itself the weekend is still running, so go back a full week.
  d.setUTCDate(d.getUTCDate() - (dayOfWeek === 0 ? 7 : dayOfWeek) - 3);
  return d.toISOString().slice(0, 10);
}

/** True when a weekend has finished but its report has not appeared yet. */
export function isAwaitingReport(history: History, now: Date = new Date()): boolean {
  const have = latestWeekendFrom(history);
  return !have || have < expectedLatestWeekend(now);
}

export const weekKey = (year: number, week: number) =>
  `${year}-W${String(week).padStart(2, "0")}`;

/**
 * Newest week first, comparing the numbers rather than the file names.
 *
 * The week is not zero-padded in the file name, so a plain string sort reads
 * `top20-2026-9cz.xls` as newer than `top20-2026-30cz.xls`. On the Monday a
 * report is due that is the difference between fetching this weekend and
 * fetching one from March.
 */
export function byWeekDescending(a: string, b: string): number {
  const left = parseFileName(a);
  const right = parseFileName(b);
  if (!left || !right) return 0;
  return right.year - left.year || right.week - left.week;
}

export type UfdIngestResult = {
  articlesScanned: number;
  filesSeen: number;
  weeksAdded: number;
  weeksKnown: number;
  annualYears: number;
  matched: number;
  unmatched: string[];
  errors: string[];
};

/**
 * @param backfill when true, walk the whole archive; otherwise only the newest
 *   article, which is where this Monday's file appears.
 */
export async function ingestUfd(
  state: State,
  history: History,
  opts: { deadline: number; backfill?: boolean },
): Promise<UfdIngestResult> {
  const result: UfdIngestResult = {
    articlesScanned: 0,
    filesSeen: 0,
    weeksAdded: 0,
    weeksKnown: 0,
    annualYears: 0,
    matched: 0,
    unmatched: [],
    errors: [],
  };

  history.ufd ??= {};

  // Poll hard while a report is due, then back off once it has landed.
  const intervalMs = isAwaitingReport(history)
    ? WAITING_INTERVAL_MINUTES * 60_000
    : REFRESH_AFTER_HOURS * 60 * 60 * 1000;
  const fresh =
    history.ufdCheckedAt &&
    Date.now() - new Date(history.ufdCheckedAt).getTime() < intervalMs &&
    // A history that has never seen an annual file is not fresh however
    // recently it was checked: without them the all-time totals are the
    // top-20 undercount this code exists to fix, and waiting out the
    // half-day back-off would leave the dashboard wrong for that long.
    Object.keys(history.ufdAnnual ?? {}).length > 0;
  if (!opts.backfill && fresh) {
    result.weeksKnown = Object.keys(history.ufd).length;
    return result;
  }

  let articles: string[];
  try {
    articles = await fetchArticleUrls(opts.backfill ? 40 : 1);
  } catch (err) {
    result.errors.push(`index: ${String(err)}`);
    return result;
  }
  // The index lists articles newest first and `fetchArticleUrls` keeps that
  // order, which is the order we want: a run that runs out of time has still
  // scanned this month. Sorting them would destroy it — the slugs are Czech
  // month names, so alphabetically "unor-february" beats "cervenec-july" and
  // the scan would start in February.

  const wanted: string[] = [];
  await rateLimited(
    articles,
    async (article) => {
      const files = await fetchWeekFileUrls(article);
      result.articlesScanned += 1;
      for (const file of files) {
        result.filesSeen += 1;
        const named = parseFileName(file);
        if (!named) continue;
        if (history.ufd![weekKey(named.year, named.week)]) continue;
        wanted.push(file);
      }
    },
    {
      minIntervalMs: 400,
      deadline: opts.deadline,
      onError: (article, err) => result.errors.push(`article ${article}: ${String(err)}`),
    },
  );

  // Newest week first, so the current picture is right even on a partial run.
  wanted.sort(byWeekDescending);

  await rateLimited(
    wanted,
    async (file) => {
      const week = await fetchWeek(file);
      store(state, history, week, result);
      result.weeksAdded += 1;
    },
    {
      minIntervalMs: 400,
      deadline: opts.deadline,
      onError: (file, err) => result.errors.push(`file ${file}: ${String(err)}`),
    },
  );

  // The annual lists close the gap the top-20 weeklies leave, so they are not
  // optional extras — a history without them undercounts every film that
  // dropped out of the ranking mid-run. A finished year's file never changes,
  // so only the years we are missing are downloaded; in steady state this is
  // one index page and nothing else.
  {
    history.ufdAnnual ??= {};
    try {
      const files = await fetchAnnualFileUrls();
      const missing = files.filter((f) => {
        const year = parseAnnualFileName(f);
        return year !== null && !history.ufdAnnual![String(year)];
      });
      await rateLimited(
        missing,
        async (file) => {
          const annual = await fetchAnnual(file);
          history.ufdAnnual![String(annual.year)] = {
            year: annual.year,
            entries: annual.rows.map((r) => ({
              rank: r.rank,
              title: r.title,
              originalTitle: r.originalTitle,
              distributor: r.distributor,
              premiere: r.premiere,
              admissions: r.admissions,
              gross: r.gross,
              screenings: r.screenings,
            })),
          };
          result.annualYears += 1;
        },
        {
          minIntervalMs: 400,
          deadline: opts.deadline,
          onError: (file, err) => result.errors.push(`annual ${file}: ${String(err)}`),
        },
      );
    } catch (err) {
      result.errors.push(`annual index: ${String(err)}`);
    }
  }

  result.weeksKnown = Object.keys(history.ufd).length;
  if (result.errors.length === 0) history.ufdCheckedAt = new Date().toISOString();
  return result;
}

function store(state: State, history: History, week: UfdWeek, result: UfdIngestResult): void {
  const entries: UfdEntry[] = week.rows.map((row) => {
    const filmId = matchFilm(state, row.title);
    if (filmId !== undefined) result.matched += 1;
    else if (!result.unmatched.includes(row.title)) result.unmatched.push(row.title);

    return {
      rank: row.rank,
      title: row.title,
      distributor: row.distributor,
      // Needed to tell a Czech release from a foreign one, which is the single
      // biggest split in how a run behaves after the opening weekend.
      country: row.country,
      weekOfRun: row.weekOfRun,
      cinemas: row.cinemas,
      weekendAdmissions: row.weekendAdmissions,
      weekendGross: row.weekendGross,
      totalAdmissions: row.totalAdmissions,
      totalGross: row.totalGross,
      filmId,
    };
  });

  history.ufd![weekKey(week.year, week.week)] = {
    year: week.year,
    week: week.week,
    weekendFrom: week.weekendFrom,
    entries,
  };
}

/**
 * Match a UFD title to a film we track.
 *
 * UFD uses the Czech distribution title, which is also what both chains show,
 * so the normalized Czech title is the right key here — there is no original
 * title in the report to fall back on.
 */
function matchFilm(state: State, title: string): number | undefined {
  const identity = filmIdentity(title, null);
  const byKey = state.films.find((f) => f.matchKey === identity.matchKey);
  if (byKey) return byKey.id;
  const byTight = state.films.find((f) => f.tightKey === identity.tightKey);
  if (byTight) return byTight.id;
  // Films whose Czech title is keyed on their original one still have to match:
  // compare against the normalized Czech title we stored on the film.
  const byTitle = state.films.find((f) => filmIdentity(f.title, null).matchKey === identity.matchKey);
  return byTitle?.id;
}

/**
 * How far back a report may be and still describe the run a film is in now.
 *
 * Even the longest Czech runs finish inside about four months, so anything
 * older belongs to a different release. Without this bound, a film returning
 * to cinemas inherits its previous run: "Tlapková patrola ve velkofilmu"
 * showed 339 332 admissions taken from its complete 2023 run, which is what
 * made the cumulative ranking read as nonsense.
 */
const CURRENT_RUN_DAYS = 200;

/**
 * The most recent cumulative total UFD has reported for a film's current run.
 *
 * A film appears in many weekly tables and its run total only grows, so the
 * highest figure is the latest one — which also survives a week where the film
 * dropped out of the top 20 and came back. The window keeps that from reaching
 * back into an earlier release of the same title.
 */
export function latestTotals(
  history: History,
  now: Date = new Date(),
): Map<number, { admissions: number; gross: number; weekendFrom: string; title: string }> {
  const since = new Date(now.getTime() - CURRENT_RUN_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);

  const best = new Map<
    number,
    { admissions: number; gross: number; weekendFrom: string; title: string }
  >();
  for (const week of Object.values(history.ufd ?? {})) {
    if (week.weekendFrom < since) continue;
    for (const e of week.entries) {
      if (e.filmId === undefined) continue;
      const current = best.get(e.filmId);
      if (!current || e.totalAdmissions > current.admissions) {
        best.set(e.filmId, {
          admissions: e.totalAdmissions,
          gross: e.totalGross,
          weekendFrom: week.weekendFrom,
          title: e.title,
        });
      }
    }
  }
  return best;
}

export type AllTimeEntry = {
  title: string;
  admissions: number;
  gross: number;
  /** `YYYY-MM-DD` of the last weekend the film was reported in. */
  lastSeen: string;
  /** Release year, inferred from the first report we have of that run. */
  year: number;
};

/**
 * The most successful releases in Czech cinemas across the whole archive.
 *
 * UFD's run total is cumulative for the life of a release, so a film returning
 * to cinemas carries on from where it left off — its total keeps climbing. That
 * gives a precise way to tell a re-release from a different film with the same
 * name: the total continuing upward is the same release, the total *resetting*
 * to something smaller is a new one. Splitting on elapsed time instead would
 * date "Bohemian Rhapsody" to its last re-release rather than its premiere.
 */
export function allTimeRanking(history: History, limit = 100): AllTimeEntry[] {
  const byTitle = new Map<string, AllTimeEntry>();

  const weeks = Object.values(history.ufd ?? {})
    .filter((w) => w.weekendFrom)
    .sort((a, b) => a.weekendFrom.localeCompare(b.weekendFrom));

  for (const week of weeks) {
    for (const e of week.entries) {
      const key = e.title.trim().toLowerCase();
      const current = byTitle.get(key);
      if (!current) {
        byTitle.set(key, {
          title: e.title.trim(),
          admissions: e.totalAdmissions,
          gross: e.totalGross,
          lastSeen: week.weekendFrom,
          // Dated by the first week we ever saw it, which is its premiere —
          // not by a re-release years later.
          year: Number(week.weekendFrom.slice(0, 4)),
        });
        continue;
      }
      // The run total is cumulative for the life of a release, so the largest
      // figure a title ever reached is what it achieved.
      current.admissions = Math.max(current.admissions, e.totalAdmissions);
      current.gross = Math.max(current.gross, e.totalGross);
      current.lastSeen = week.weekendFrom;
    }
  }

  // The annual lists are authoritative where they overlap: a weekly figure is
  // only ever the film's total on the day it was still inside the top 20, while
  // the annual file reports the finished run. They also reach back further than
  // the weeklies we hold, so titles missing above get added here.
  for (const year of Object.values(history.ufdAnnual ?? {})) {
    for (const e of year.entries) {
      const key = e.title.trim().toLowerCase();
      const current = byTitle.get(key);
      const premiereYear = e.premiere ? Number(e.premiere.slice(0, 4)) : year.year;
      if (!current) {
        byTitle.set(key, {
          title: e.title.trim(),
          admissions: e.admissions,
          gross: e.gross,
          lastSeen: e.premiere ?? `${year.year}-12-31`,
          year: premiereYear,
        });
        continue;
      }
      current.admissions = Math.max(current.admissions, e.admissions);
      current.gross = Math.max(current.gross, e.gross);
      // A premiere date beats a guess made from the first weekend we saw.
      if (e.premiere) current.year = premiereYear;
    }
  }

  return [...byTitle.values()].sort((a, b) => b.admissions - a.admissions).slice(0, limit);
}

/** The newest weekend UFD has published, as `YYYY-MM-DD`. */
export function latestWeekendFrom(history: History): string | null {
  const dates = Object.values(history.ufd ?? {})
    .map((w) => w.weekendFrom)
    .filter(Boolean)
    .sort();
  return dates.length ? dates[dates.length - 1] : null;
}

/**
 * A film's weekend line from the official tables, oldest first.
 *
 * The forecast needs the run as a series, not just its latest total: how the
 * weekends fall against each other is the whole signal. Bounded by the same
 * window as `latestTotals`, so a re-release does not inherit the shape of an
 * earlier run of the same title.
 */
export function runSeries(
  history: History,
  now: Date = new Date(),
): Map<number, { country: string | null; points: WeekendPoint[] }> {
  const since = new Date(now.getTime() - CURRENT_RUN_DAYS * 86_400_000).toISOString().slice(0, 10);
  const runs = new Map<number, { country: string | null; points: WeekendPoint[] }>();

  const weeks = Object.values(history.ufd ?? {})
    .filter((w) => w.weekendFrom && w.weekendFrom >= since)
    .sort((a, b) => a.weekendFrom.localeCompare(b.weekendFrom));

  for (const week of weeks) {
    for (const e of week.entries) {
      if (e.filmId === undefined) continue;
      const run = runs.get(e.filmId) ?? { country: e.country ?? null, points: [] };
      run.country ??= e.country ?? null;
      // A film can appear twice in a week only through a data fault; keeping
      // the first is enough to stop it distorting the decay. The true weekOfRun
      // is passed through untouched — including UFD's week 0 — so the forecast's
      // own normalization can tell a preview from a 0-indexed opening.
      if (!run.points.some((p) => p.weekOfRun === e.weekOfRun)) {
        run.points.push({
          weekOfRun: e.weekOfRun,
          weekendAdmissions: e.weekendAdmissions,
          totalAdmissions: e.totalAdmissions,
          cinemas: e.cinemas,
        });
      }
      runs.set(e.filmId, run);
    }
  }
  return runs;
}

/**
 * Re-resolve every stored report line against the current catalogue.
 *
 * `filmId` used to be written once, when the week was first downloaded, and
 * then trusted forever. Two things break that. A film can appear in the
 * official table before either chain lists it, so at ingest time there is
 * nothing to match and the line stays unlinked for good. And merging duplicate
 * films renumbers ids — after Golden Apple's second "Spider-Man" was folded
 * away, the top line of the newest report still pointed at the id that had just
 * been deleted, so the film showed no official total and no forecast at all
 * while sitting first in the table with 202 867 admissions.
 *
 * Rebuilding the link each run costs a few milliseconds and cannot go stale.
 */
export function relinkUfd(state: State, history: History): number {
  const byMatchKey = new Map<string, number>();
  const byTightKey = new Map<string, number>();
  const byCzech = new Map<string, number>();
  for (const film of state.films) {
    if (!byMatchKey.has(film.matchKey)) byMatchKey.set(film.matchKey, film.id);
    if (!byTightKey.has(film.tightKey)) byTightKey.set(film.tightKey, film.id);
    const czech = film.czechKey ?? filmIdentity(film.title, null).matchKey;
    if (czech && !byCzech.has(czech)) byCzech.set(czech, film.id);
  }

  const resolve = (title: string): number | undefined => {
    const identity = filmIdentity(title, null);
    return (
      byMatchKey.get(identity.matchKey) ??
      byTightKey.get(identity.tightKey) ??
      byCzech.get(identity.czechKey)
    );
  };

  let changed = 0;
  const cache = new Map<string, number | undefined>();
  for (const week of Object.values(history.ufd ?? {})) {
    for (const entry of week.entries) {
      const key = entry.title.trim().toLowerCase();
      if (!cache.has(key)) cache.set(key, resolve(entry.title));
      const filmId = cache.get(key);
      if (filmId === entry.filmId) continue;
      // Only ever add or correct a link; never drop one because the film has
      // since left the working set and been folded into history.
      if (filmId === undefined && entry.filmId !== undefined) continue;
      entry.filmId = filmId;
      changed += 1;
    }
  }
  return changed;
}
