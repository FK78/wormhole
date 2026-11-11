import assert from "node:assert/strict";
import test from "node:test";
import { startDatabaseMonitor } from "../../src/services/databaseMonitor.ts";
import { createLogger } from "../../src/observability/logger.ts";
import { recordDatabaseCheck, renderMetrics } from "../../src/observability/metrics.ts";

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

const waitFor = async (
  predicate: () => boolean,
  timeoutMs = 1_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(5);
  }

  assert.fail("condition was not met before the timeout");
};

const databaseUp = (): boolean => {
  const line = renderMetrics()
    .split("\n")
    .find((candidate) => candidate.startsWith("wormhole_database_up "));

  assert.ok(line, "wormhole_database_up is missing");

  return line.endsWith(" 1");
};

test("records availability transitions and updates the gauge", async () => {
  const lines: string[] = [];
  const logger = createLogger({
    service: "wormhole-test",
    level: "debug",
    sink: (line) => {
      lines.push(line);
    },
  });

  let up = true;
  const monitor = startDatabaseMonitor({
    intervalMs: 5,
    logger,
    check: async () => up,
  });

  try {
    await waitFor(databaseUp);
    assert.equal(databaseUp(), true);

    up = false;
    await waitFor(() => !databaseUp());

    up = true;
    await waitFor(databaseUp);

    const messages = lines.map(
      (line) => JSON.parse(line) as Record<string, unknown>,
    );

    assert.ok(
      messages.some(
        (entry) =>
          entry.level === "error" &&
          entry.message === "database became unavailable",
      ),
      lines.join("\n"),
    );
    assert.ok(
      messages.some(
        (entry) =>
          entry.level === "info" &&
          entry.message === "database availability restored",
      ),
      lines.join("\n"),
    );
  } finally {
    monitor.stop();
  }

  const count = lines.length;
  await sleep(30);
  assert.equal(lines.length, count, "monitor logged after stop()");
});

test("a throwing check is treated as unavailable", async () => {
  recordDatabaseCheck(true);

  const monitor = startDatabaseMonitor({
    intervalMs: 5,
    logger: createLogger({ service: "wormhole-test", level: "error", sink: () => {} }),
    check: async () => {
      throw new Error("probe exploded");
    },
  });

  try {
    await waitFor(() => !databaseUp());
  } finally {
    monitor.stop();
  }
});
