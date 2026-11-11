import { pool } from "../db/db.ts";

export const READINESS_TIMEOUT_MS = 1_000;

export const isDatabaseReady = async (
  timeoutMs = READINESS_TIMEOUT_MS,
): Promise<boolean> => {
  let timer: NodeJS.Timeout | undefined;

  try {
    await Promise.race([
      pool.query("SELECT 1"),
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
