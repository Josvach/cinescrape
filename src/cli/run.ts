/**
 * The whole pipeline, as one command.
 *
 *   npm run ingest            everything due right now
 *   npm run ingest -- discover  also refresh the CineStar schedule
 *
 * Reads the JSON state, talks to both chains, writes the state back and
 * regenerates the dashboard's data file. No server, no database, no daemon —
 * a scheduler just has to run this every few minutes.
 */

import { ingestCinemaCity } from "@/ingest/cinemacity";
import { discoverCineStarSchedule, pollCineStarHalls } from "@/ingest/cinestar";
import { settleScreenings } from "@/ingest/settle";
import { computeLive } from "@/stats/compute";
import { loadHistory, loadState, saveHistory, saveLive, saveState } from "@/store/store";

/** Leaves room inside a five-minute tick for two chains and the write-back. */
const DEFAULT_BUDGET_MS = 3 * 60_000;

async function main() {
  const withDiscovery = process.argv.includes("discover");
  const budgetMs = Number(process.env.JOB_BUDGET_MS ?? DEFAULT_BUDGET_MS);
  const startedAt = Date.now();

  const state = await loadState();
  const history = await loadHistory();

  const report: Record<string, unknown> = {};
  const errors: string[] = [];

  // Cinema City first: it is one request for the entire chain, so it always
  // fits, and its data is the bulk of the dashboard.
  try {
    const cc = await ingestCinemaCity(state, { deadline: startedAt + budgetMs * 0.4 });
    report.cinemaCity = { ...cc, errors: cc.errors.length };
    errors.push(...cc.errors);
  } catch (err) {
    errors.push(`cinemacity: ${String(err)}`);
  }

  if (withDiscovery) {
    try {
      const disc = await discoverCineStarSchedule(state, {
        deadline: startedAt + budgetMs * 0.7,
      });
      report.cineStarSchedule = { ...disc, errors: disc.errors.length };
      errors.push(...disc.errors);
    } catch (err) {
      errors.push(`cinestar-schedule: ${String(err)}`);
    }
  }

  try {
    const poll = await pollCineStarHalls(state, { deadline: startedAt + budgetMs });
    report.cineStarHalls = { ...poll, errors: poll.errors.length };
    errors.push(...poll.errors);
  } catch (err) {
    errors.push(`cinestar-halls: ${String(err)}`);
  }

  report.settle = settleScreenings(state, history);

  // Written even if a source failed: a partial update is better than letting
  // the dashboard go stale, and the failure is reported below either way.
  await saveState(state);
  await saveHistory(history);
  await saveLive(computeLive(state, history));

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`done in ${elapsed}s`, JSON.stringify(report));

  if (errors.length) {
    // Upstream hiccups are normal and the next run retries them. Failing the
    // build on every 503 would train everyone to ignore a red job.
    console.warn(`${errors.length} recoverable error(s):`);
    for (const e of errors.slice(0, 10)) console.warn(`  ${e}`);
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("run failed:", err);
    process.exit(1);
  },
);
