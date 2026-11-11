import type { QueryConfig } from "pg";
import { pool } from "../db/db.ts";

// @types/pg does not declare the per-query `query_timeout` option, but
// node-postgres honours it (pg/lib/client.js reads config.query_timeout).
type QueryConfigWithTimeout = QueryConfig & { query_timeout: number };

export const READINESS_TIMEOUT_MS = 1_000;

export const isDatabaseReady = async (
  timeoutMs = READINESS_TIMEOUT_MS,
): Promise<boolean> => {
  let timer: NodeJS.Timeout | undefined;

  const readinessQuery: QueryConfigWithTimeout = {
    text: "SELECT 1",
    // pg's own client-side timeout makes pg-pool release and destroy the
    // connection when it fires. Without it, losing the race below leaves the
    // query pending with a checked-out client, and repeated readiness probes
    // can exhaust the pool during a database outage.
    query_timeout: timeoutMs,
  };

  try {
    await Promise.race([
      pool.query(readinessQuery),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Database readiness check timed out")),
          timeoutMs,
        );
      }),
    ]);

    return true;
  } catch {
    // Never surface database error details to the caller.
    return false;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};
