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
  fetchArticleUrls,
  fetchWeek,
  fetchWeekFileUrls,
  parseFileName,
  type UfdWeek,
} from "@/sources/ufd";
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

export type UfdIngestResult = {
  articlesScanned: number;
  filesSeen: number;
  weeksAdded: number;
  weeksKnown: number;
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
    Date.now() - new Date(history.ufdCheckedAt).getTime() < intervalMs;
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
  // Newest first: a run that runs out of time has still taken this week's file.
  articles.sort().reverse();

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
  wanted.sort().reverse();

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
 * The most recent cumulative total UFD has reported for a film.
 *
 * A film appears in many weekly tables; its run total only grows, so the
 * highest figure across them is the latest one — and it survives a week where
 * the film dropped out of the top 20 and came back.
 */
export function latestTotals(
  history: History,
): Map<number, { admissions: number; gross: number; weekendFrom: string; title: string }> {
  const best = new Map<
    number,
    { admissions: number; gross: number; weekendFrom: string; title: string }
  >();
  for (const week of Object.values(history.ufd ?? {})) {
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

/** The newest weekend UFD has published, as `YYYY-MM-DD`. */
export function latestWeekendFrom(history: History): string | null {
  const dates = Object.values(history.ufd ?? {})
    .map((w) => w.weekendFrom)
    .filter(Boolean)
    .sort();
  return dates.length ? dates[dates.length - 1] : null;
}
