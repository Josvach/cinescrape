import { db } from "@/db/client";
import { finishJobRun, startJobRun } from "@/ingest/repo";

/**
 * Wall-clock budget for a cron invocation, kept below the function's
 * `maxDuration` so the job can finish its bookkeeping instead of being killed
 * mid-write. Jobs that cannot finish simply resume on the next tick.
 */
const BUDGET_MS = 100_000;

/**
 * Vercel Cron sends `Authorization: Bearer <CRON_SECRET>`. Without the check
 * these endpoints would let anyone make us hammer the cinema chains.
 */
function authorize(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

export async function runCron<T>(
  req: Request,
  job: string,
  fn: (ctx: { deadline: number }) => Promise<T>,
): Promise<Response> {
  if (!authorize(req)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const deadline = Date.now() + BUDGET_MS;
  const d = db();
  const runId = await startJobRun(d, job);

  try {
    const result = await fn({ deadline });
    const items =
      typeof result === "object" && result !== null
        ? Object.values(result as Record<string, unknown>).find((v) => typeof v === "number")
        : undefined;
    await finishJobRun(d, runId, {
      ok: true,
      itemsProcessed: typeof items === "number" ? items : 0,
      note: JSON.stringify(result),
    });
    return Response.json({ job, ok: true, ...result });
  } catch (err) {
    await finishJobRun(d, runId, { ok: false, itemsProcessed: 0, note: String(err) });
    return Response.json({ job, ok: false, error: String(err) }, { status: 500 });
  }
}
