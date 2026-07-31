/**
 * Standalone entry point for the ingest jobs.
 *
 * The same work is reachable over HTTP at /api/cron/*, but scheduling those
 * needs a paid Vercel plan — the Hobby tier only fires cron once a day, which
 * is useless for data that has to be captured before each screening starts.
 * Running the jobs from any external scheduler (GitHub Actions, a cheap VPS,
 * anything with a crontab) keeps the hosting free without giving up the cadence.
 *
 *   npx tsx src/cli/run-job.ts cinemacity
 */

import { ingestCinemaCity } from "@/ingest/cinemacity";
import { discoverCineStarSchedule, pollCineStarHalls } from "@/ingest/cinestar";
import { finishJobRun, startJobRun } from "@/ingest/repo";
import { pruneSnapshots, settleScreenings } from "@/ingest/settle";
import { db } from "@/db/client";

/**
 * Outside a serverless function there is no platform timeout, but an unbounded
 * run would overlap with the next scheduled one. Five minutes keeps each job
 * inside its own slot.
 */
const DEFAULT_BUDGET_MS = 5 * 60_000;

const JOBS = {
  cinemacity: (ctx: { deadline: number }) => ingestCinemaCity(ctx),
  "cinestar-schedule": (ctx: { deadline: number }) => discoverCineStarSchedule(ctx),
  "cinestar-halls": (ctx: { deadline: number }) => pollCineStarHalls(ctx),
  settle: async (ctx: { deadline: number }) => {
    const settled = await settleScreenings(ctx);
    return { ...settled, pruned: await pruneSnapshots() };
  },
} as const;

type JobName = keyof typeof JOBS;

async function main() {
  const name = process.argv[2] as JobName | undefined;
  if (!name || !(name in JOBS)) {
    console.error(`usage: run-job <${Object.keys(JOBS).join("|")}>`);
    process.exit(2);
  }

  const budgetMs = Number(process.env.JOB_BUDGET_MS ?? DEFAULT_BUDGET_MS);
  const deadline = Date.now() + budgetMs;
  const startedAt = Date.now();

  const d = db();
  const runId = await startJobRun(d, name);

  try {
    const result = await JOBS[name]({ deadline });
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    await finishJobRun(d, runId, {
      ok: true,
      itemsProcessed:
        typeof result === "object" && result !== null
          ? (Object.values(result).find((v) => typeof v === "number") as number) ?? 0
          : 0,
      note: JSON.stringify(result),
    });
    console.log(`${name} ok in ${elapsed}s`, JSON.stringify(result));

    // Errors inside a run are recoverable (a 503 from one programme page, say)
    // and the next tick retries them, so they are reported without failing the
    // job — a red build every time an upstream hiccups trains people to ignore it.
    const errors = (result as { errors?: string[] }).errors;
    if (errors?.length) console.warn(`${name}: ${errors.length} recoverable error(s)`);
    process.exit(0);
  } catch (err) {
    await finishJobRun(d, runId, { ok: false, itemsProcessed: 0, note: String(err) });
    console.error(`${name} failed:`, err);
    process.exit(1);
  }
}

void main();
