import { Pool } from "pg";
import type { DatabaseConfig } from "../config.ts";
import { getLogger } from "../observability/logger.ts";
import { registerGaugeCollector } from "../observability/metrics.ts";
import { isTransientDbError, retryWithBackoff } from "./retry.ts";

const DB_READY_ATTEMPTS = 10;
const DB_READY_BASE_DELAY_MS = 250;
const DB_READY_MAX_DELAY_MS = 5_000;

let pool: Pool | undefined;

registerGaugeCollector(
  "wormhole_db_pool_total_connections",
  "Connections currently held by the pool, both in use and idle.",
  () => pool?.totalCount ?? 0,
);

registerGaugeCollector(
  "wormhole_db_pool_idle_connections",
  "Idle connections currently held by the pool.",
  () => pool?.idleCount ?? 0,
);

registerGaugeCollector(
  "wormhole_db_pool_waiting_clients",
  "Requests waiting for a pool connection.",
  () => pool?.waitingCount ?? 0,
);

registerGaugeCollector(
  "wormhole_db_pool_max_connections",
  "Maximum number of connections the pool may hold.",
  () => pool?.options?.max ?? 0,
);

export const createPool = (config: DatabaseConfig): Pool => {
  const created = new Pool({
    host: config.host,
    user: config.user,
    password: config.password,
    port: config.port,
    database: config.database,
    connectionTimeoutMillis: config.connectTimeoutMs,
  });

  // pg-pool removes broken idle clients and creates new ones on demand.
  // Without this listener, an idle client error (for example PostgreSQL
  // restarting and sending 57P01) is an unhandled EventEmitter "error" event
  // and kills Node.
  created.on("error", (err) => {
    const code = (err as NodeJS.ErrnoException).code ?? "unknown";
    getLogger().error("database idle client error", {
      code,
      error: err,
    });
  });

  pool = created;
  return created;
};

export const getPool = (): Pool => {
  if (!pool) {
    throw new Error("Database pool has not been created");
  }

  return pool;
};

export const waitForDatabase = async (): Promise<void> => {
  const db = getPool();

  await retryWithBackoff(() => db.query("SELECT 1"), {
    attempts: DB_READY_ATTEMPTS,
    baseDelayMs: DB_READY_BASE_DELAY_MS,
    maxDelayMs: DB_READY_MAX_DELAY_MS,
    shouldRetry: isTransientDbError,
    onRetry: (err, attempt, delayMs) => {
      const code = (err as NodeJS.ErrnoException).code ?? "unknown";
      getLogger().warn(
        `[db] not ready (attempt ${attempt}/${DB_READY_ATTEMPTS}, ${code}); retrying in ${delayMs}ms`,
        { attempt, maxAttempts: DB_READY_ATTEMPTS, code, delayMs },
      );
    },
  });
};
