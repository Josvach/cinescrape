import { pollCineStarHalls } from "@/ingest/cinestar";

import { runCron } from "../_run";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export function GET(req: Request) {
  return runCron(req, "cinestar-halls", (ctx) => pollCineStarHalls(ctx));
}
