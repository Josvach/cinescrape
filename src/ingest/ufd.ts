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
import {
  fetchArticleUrls,
  fetchWeek,
  fetchWeekFileUrls,
  parseFileName,
  type UfdWeek,
} from "@/sources/ufd";
import type { History, State, UfdEntry } from "@/store/types";

/** How often to look for a new weekly report once the backfill is done. */
const REFRESH_AFTER_HOURS = 12;

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

  const fresh =
    history.ufdCheckedAt &&
    Date.now() - new Date(history.ufdCheckedAt).getTime() < REFRESH_AFTER_HOURS * 60 * 60 * 1000;
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
