import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import * as schema from "./schema";

let cached: ReturnType<typeof drizzle<typeof schema>> | undefined;

/**
 * A pooled TCP connection rather than Neon's HTTP driver.
 *
 * The ingest jobs issue hundreds of small sequential statements per run, and
 * one HTTP round trip each would eat the cron time budget long before the work
 * was done. Point DATABASE_URL at Neon's *pooled* endpoint in production; the
 * same code then talks to a plain local Postgres in development and in tests.
 */
export function db() {
  if (!cached) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is not set");
    const pool = new Pool({
      connectionString,
      max: 5,
      // Serverless instances are frozen between invocations; a short idle
      // timeout keeps us from holding connections we can no longer use.
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000,
      ssl: connectionString.includes("localhost") || connectionString.includes("127.0.0.1")
        ? undefined
        : { rejectUnauthorized: true },
    });
    cached = drizzle(pool, { schema });
  }
  return cached;
}

export { schema };
