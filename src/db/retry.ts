const TRANSIENT_CODES = new Set([
  // PostgreSQL connection failures and recovery states
  "57P01", // admin_shutdown
  "57P02", // crash_shutdown
  "57P03", // cannot_connect_now
  "53300", // too_many_connections
  "08000", // connection_exception
  "08001", // sqlclient_unable_to_establish_sqlconnection
  "08003", // connection_does_not_exist
  "08004", // sqlserver_rejected_establishment_of_sqlconnection
  "08006", // connection_failure
  "08007", // transaction_resolution_unknown
  "08P01", // protocol_violation

  // Node network errors
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
]);

const TRANSIENT_MESSAGE =
  /timeout exceeded when trying to connect|Connection terminated due to connection timeout|Connection terminated unexpectedly|Client has encountered a connection error and is not queryable/i;

export type RetryOptions = {
  attempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  shouldRetry: (err: unknown) => boolean;
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
  sleep?: (ms: number) => Promise<void>;
};

export const isTransientDbError = (err: unknown): boolean => {
  if (!(err instanceof Error)) return false;

  const code = (err as NodeJS.ErrnoException).code;
  if (typeof code === "string" && TRANSIENT_CODES.has(code)) return true;

  return TRANSIENT_MESSAGE.test(err.message);
};

export const computeBackoffDelay = (
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  random: () => number = Math.random,
): number => {
  const exponential = Math.min(
    maxDelayMs,
    baseDelayMs * 2 ** Math.max(0, attempt - 1),
  );
  const jitter = 0.5 + random() / 2;

  return Math.round(exponential * jitter);
};

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export const retryWithBackoff = async <T>(
  operation: () => Promise<T>,
  options: RetryOptions,
): Promise<T> => {
  if (options.attempts < 1) {
    throw new RangeError("attempts must be at least 1");
  }

  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    try {
      return await operation();
    } catch (err) {
      const isLastAttempt = attempt === options.attempts;

      if (isLastAttempt || !options.shouldRetry(err)) {
        throw err;
      }

      const delayMs = computeBackoffDelay(
        attempt,
        options.baseDelayMs,
        options.maxDelayMs,
      );

      options.onRetry?.(err, attempt, delayMs);
      await (options.sleep ?? sleep)(delayMs);
    }
  }

  throw new Error("retryWithBackoff exhausted without an error");
};
