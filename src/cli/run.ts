/**
 * The whole pipeline, as one command.
 *
 *   npm run ingest              everything due right now
 *   npm run ingest -- discover  also refresh the CineStar schedule
 *   npm run ingest -- loop      keep going every few minutes
 *
 * Reads the JSON state, talks to both chains, writes the state back and
 * regenerates the dashboard's data file. No server, no database, no daemon.
 *
 * `loop` exists because GitHub does not honour a five-minute cron. Measured on
 * this project's own repository: two scheduled runs in three hours where
 * thirty-six were asked for. Short intervals are queued and dropped under load, so the
 * cadence cannot live in the cron expression. One hourly trigger — which
 * GitHub does fire reliably — running a job that iterates internally gets the
 * five-minute rhythm the final-reading capture depends on.
 */

import { ingestCinemaCity } from "@/ingest/cinemacity";
import { refreshFilmContext } from "@/ingest/context";
import { discoverCineStarSchedule, pollCineStarHalls } from "@/ingest/cinestar";
import { settleScreenings } from "@/ingest/settle";
import { computeLive } from "@/stats/compute";
import { loadHistory, loadState, saveHistory, saveLive, saveState } from "@/store/store";

/** Leaves room inside a five-minute tick for two chains and the write-back. */
const DEFAULT_BUDGET_MS = 3 * 60_000;

async function main() {
  if (process.argv.includes("loop")) return loop();
  await once(process.argv.includes("discover"));
}

/**
 * Iterate until the run's wall-clock allowance is used up.
 *
 * The allowance stops a little short of the next trigger so two jobs never
 * overlap on the same published state. Discovery runs once at the start of each
 * loop rather than every iteration: newly listed screenings appear days ahead,
 * so refetching twelve programme pages every five minutes would be needless
 * load on cinestar.cz.
 */
async function loop() {
  const totalMs = Number(process.env.LOOP_MINUTES ?? 50) * 60_000;
  const intervalMs = Number(process.env.LOOP_INTERVAL_SECONDS ?? 300) * 1000;
  const until = Date.now() + totalMs;

  let iteration = 0;
  while (Date.now() < until) {
    const startedAt = Date.now();
    console.log(`--- iterace ${++iteration} ---`);
    try {
      await once(iteration === 1);
      // Publishing has to happen per iteration, not once at the end: the whole
      // point of looping is that the dashboard moves every few minutes rather
      // than once an hour.
      await publish();
    } catch (err) {
      // One bad iteration must not end the loop; the next one retries.
      console.error("iterace selhala:", err);
    }

    const nextAt = startedAt + intervalMs;
    if (nextAt >= until) break;
    const wait = Math.max(0, nextAt - Date.now());
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
  console.log(`hotovo, ${iteration} iterací`);
}

/**
 * Hand the freshly written data to whatever publishes it, if anything.
 *
 * Kept as an opaque command so this file knows nothing about git or hosting —
 * locally there is no PUBLISH_CMD and the files on disk are the output.
 */
async function publish(): Promise<void> {
  const cmd = process.env.PUBLISH_CMD;
  if (!cmd) return;
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { stdout } = await promisify(execFile)("sh", ["-c", cmd], { timeout: 120_000 });
  if (stdout.trim()) console.log(stdout.trim());
}

async function once(withDiscovery: boolean) {
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

  // Last, and only with whatever budget is left over: articles and ratings are
  // the one part of this that is still there if a run skips it.
  try {
    const ctx = await refreshFilmContext(state, { deadline: startedAt + budgetMs * 1.3 });
    if (ctx.refreshed > 0) report.context = { ...ctx, errors: ctx.errors.length };
    errors.push(...ctx.errors);
  } catch (err) {
    errors.push(`context: ${String(err)}`);
  }

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
