import { Pool } from "pg";
import { isTransientDbError, retryWithBackoff } from "./retry.ts";

const readPositiveInt = (name: string, fallback: number): number => {
    const value = Number(process.env[name]);
    return Number.isFinite(value) && value > 0 ? value : fallback;
};

const DB_READY_ATTEMPTS = 10;
const DB_READY_BASE_DELAY_MS = 250;
const DB_READY_MAX_DELAY_MS = 5_000;

export const pool = new Pool({
    host: process.env.HOST,
    user: process.env.POSTGRES_USER,
    password: process.env.POSTGRES_PASSWORD,
    port: Number(process.env.POSTGRES_PORT),
    database: process.env.POSTGRES_DB,
    connectionTimeoutMillis: readPositiveInt("DB_CONNECT_TIMEOUT_MS", 5_000),
})

// pg-pool removes broken idle clients and creates new ones on demand. Without
// this listener, an idle client error (for example PostgreSQL restarting and
// sending 57P01) is an unhandled EventEmitter "error" event and kills Node.
pool.on("error", (err) => {
    const code = (err as NodeJS.ErrnoException).code ?? "unknown";
    console.error(`[db] idle client error (${code}): ${err.message}`);
})

export const waitForDatabase = async (): Promise<void> => {
    await retryWithBackoff(
        () => pool.query("SELECT 1"),
        {
            attempts: DB_READY_ATTEMPTS,
            baseDelayMs: DB_READY_BASE_DELAY_MS,
            maxDelayMs: DB_READY_MAX_DELAY_MS,
            shouldRetry: isTransientDbError,
            onRetry: (err, attempt, delayMs) => {
                const code = (err as NodeJS.ErrnoException).code ?? "unknown";
                console.warn(
                    `[db] not ready (attempt ${attempt}/${DB_READY_ATTEMPTS}, ${code}); retrying in ${delayMs}ms`,
                );
            },
        },
    );
}
