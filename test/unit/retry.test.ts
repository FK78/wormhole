import assert from "node:assert/strict";
import test from "node:test";
import {
  computeBackoffDelay,
  isTransientDbError,
  retryWithBackoff,
} from "../../src/db/retry.ts";

const dbError = (code: string) =>
  Object.assign(new Error(`database error: ${code}`), { code });

test("computeBackoffDelay grows exponentially and respects the cap", () => {
  assert.equal(computeBackoffDelay(1, 100, 1_000, () => 0), 50);
  assert.equal(computeBackoffDelay(2, 100, 1_000, () => 0), 100);
  assert.equal(computeBackoffDelay(3, 100, 1_000, () => 0), 200);
  assert.equal(computeBackoffDelay(5, 100, 1_000, () => 0), 500);
  assert.equal(computeBackoffDelay(1, 100, 1_000, () => 1), 100);
  assert.equal(computeBackoffDelay(5, 100, 1_000, () => 1), 1_000);
});

test("isTransientDbError recognizes connection and recovery errors", () => {
  for (const code of [
    "57P01",
    "57P02",
    "57P03",
    "53300",
    "08000",
    "08001",
    "08003",
    "08004",
    "08006",
    "08007",
    "08P01",
    "ECONNREFUSED",
    "ECONNRESET",
    "ETIMEDOUT",
    "EPIPE",
    "ENOTFOUND",
    "EAI_AGAIN",
    "EHOSTUNREACH",
    "ENETUNREACH",
  ]) {
    assert.equal(isTransientDbError(dbError(code)), true, code);
  }

  assert.equal(
    isTransientDbError(new Error("timeout exceeded when trying to connect")),
    true,
  );
  assert.equal(
    isTransientDbError(
      new Error("Connection terminated due to connection timeout"),
    ),
    true,
  );
});

test("isTransientDbError rejects configuration and unknown errors", () => {
  for (const code of ["28P01", "3D000", "28000", "42601"]) {
    assert.equal(isTransientDbError(dbError(code)), false, code);
  }

  assert.equal(isTransientDbError(new Error("boom")), false);
  assert.equal(isTransientDbError("boom"), false);
  assert.equal(isTransientDbError(undefined), false);
});

test("retryWithBackoff retries transient failures and returns the result", async () => {
  const failures = [dbError("57P01"), dbError("ECONNREFUSED")];
  const retries: Array<{ attempt: number; delayMs: number }> = [];
  const sleeps: number[] = [];
  let calls = 0;

  const result = await retryWithBackoff(
    async () => {
      calls += 1;
      if (failures.length > 0) throw failures.shift();
      return "ok";
    },
    {
      attempts: 5,
      baseDelayMs: 10,
      maxDelayMs: 100,
      shouldRetry: isTransientDbError,
      onRetry: (_err, attempt, delayMs) => {
        retries.push({ attempt, delayMs });
      },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    },
  );

  assert.equal(result, "ok");
  assert.equal(calls, 3);
  assert.deepEqual(
    retries.map(({ attempt }) => attempt),
    [1, 2],
  );
  assert.deepEqual(
    sleeps,
    retries.map(({ delayMs }) => delayMs),
  );
});

test("retryWithBackoff stops after the configured attempt count", async () => {
  const err = dbError("57P01");
  const sleeps: number[] = [];
  let calls = 0;

  await assert.rejects(
    () =>
      retryWithBackoff(
        async () => {
          calls += 1;
          throw err;
        },
        {
          attempts: 3,
          baseDelayMs: 1,
          maxDelayMs: 10,
          shouldRetry: isTransientDbError,
          sleep: async (ms) => {
            sleeps.push(ms);
          },
        },
      ),
    (received: unknown) => received === err,
  );

  assert.equal(calls, 3);
  assert.equal(sleeps.length, 2);
});

test("retryWithBackoff does not retry non-transient errors", async () => {
  const err = dbError("28P01");
  const sleeps: number[] = [];
  let calls = 0;

  await assert.rejects(
    () =>
      retryWithBackoff(
        async () => {
          calls += 1;
          throw err;
        },
        {
          attempts: 3,
          baseDelayMs: 1,
          maxDelayMs: 10,
          shouldRetry: isTransientDbError,
          sleep: async (ms) => {
            sleeps.push(ms);
          },
        },
      ),
    (received: unknown) => received === err,
  );

  assert.equal(calls, 1);
  assert.equal(sleeps.length, 0);
});
