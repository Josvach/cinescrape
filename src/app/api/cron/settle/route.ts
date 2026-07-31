import { settleScreenings } from "@/ingest/settle";

import { runCron } from "../_run";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export function GET(req: Request) {
  return runCron(req, "settle", (ctx) => settleScreenings(ctx));
}
