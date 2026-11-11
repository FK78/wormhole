import assert from "node:assert/strict";
import test from "node:test";
import {
  configureLogger,
  createLogger,
  getLogger,
  redactString,
  runWithRequestLogContext,
} from "../../src/observability/logger.ts";

// Keep the process-wide logger from writing to the test runner's output.
const rootLines: string[] = [];
configureLogger({ sink: (line) => rootLines.push(line) });

const capture = (level: "debug" | "info" | "warn" | "error" = "debug") => {
  const lines: string[] = [];
  const logger = createLogger({
    service: "wormhole-test",
    level,
    now: () => new Date("2026-11-11T12:34:56.789Z"),
    sink: (line) => {
      lines.push(line);
    },
  });

  return { logger, lines, parse: () => lines.map((line) => JSON.parse(line)) };
};

test("writes one machine-parseable JSON object per log line", () => {
  const { logger, lines, parse } = capture();

  logger.info("HTTP request completed", {
    requestId: "req-123",
    method: "GET",
    route: "/shorten/:id",
    status: 200,
    durationMs: 1.25,
  });

  assert.equal(lines.length, 1);
  const entry = parse()[0];
  assert.deepEqual(entry, {
    timestamp: "2026-11-11T12:34:56.789Z",
    level: "info",
    service: "wormhole-test",
    message: "HTTP request completed",
    requestId: "req-123",
    method: "GET",
    route: "/shorten/:id",
    status: 200,
    durationMs: 1.25,
  });
});

test("filters messages below the configured level", () => {
  const { logger, parse } = capture("warn");

  logger.debug("debug message");
  logger.info("info message");
  logger.warn("warn message");
  logger.error("error message");

  assert.deepEqual(
    parse().map((entry) => entry.level),
    ["warn", "error"],
  );
});

test("child loggers merge context without dropping request IDs", () => {
  const { logger, parse } = capture();

  logger
    .child({ requestId: "req-abc", component: "db" })
    .info("query failed", { code: "57P01" });

  const [entry] = parse();
  assert.equal(entry?.requestId, "req-abc");
  assert.equal(entry?.component, "db");
  assert.equal(entry?.code, "57P01");
});

test("getLogger returns the request-scoped logger inside the async context", () => {
  const { logger, parse } = capture();
  const requestLogger = logger.child({ requestId: "req-async" });

  runWithRequestLogContext({ requestId: "req-async", logger: requestLogger }, () => {
    getLogger().info("inside request");
  });

  getLogger().info("outside request");

  const entries = parse();
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.requestId, "req-async");

  const outside = JSON.parse(rootLines.at(-1)!) as Record<string, unknown>;
  assert.equal(outside.requestId, undefined);
});

test("the request context survives awaits and timer callbacks", async () => {
  const { logger, parse } = capture();
  const requestLogger = logger.child({ requestId: "req-async-2" });

  await runWithRequestLogContext(
    { requestId: "req-async-2", logger: requestLogger },
    async () => {
      await Promise.resolve();
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      getLogger().info("after await");
    },
  );

  const [entry] = parse();
  assert.equal(entry?.requestId, "req-async-2");
  assert.equal(entry?.message, "after await");
});

test("redacts sensitive object keys at every nesting level", () => {
  const { logger, parse } = capture();

  logger.error("request failed", {
    password: "hunter2",
    pwd: "hunter3",
    headers: {
      authorization: "Bearer super-secret-token",
      cookie: "session=abc",
      accept: "application/json",
    },
    database: { clientSecret: "shhh", host: "db.internal" },
  });

  const entry = parse()[0] as Record<string, unknown>;
  const headers = entry.headers as Record<string, unknown>;
  const database = entry.database as Record<string, unknown>;

  assert.equal(entry.password, "[REDACTED]");
  assert.equal(entry.pwd, "[REDACTED]");
  assert.equal(headers.authorization, "[REDACTED]");
  assert.equal(headers.cookie, "[REDACTED]");
  assert.equal(headers.accept, "application/json");
  assert.equal(database.clientSecret, "[REDACTED]");
  assert.equal(database.host, "db.internal");
});

test("redacts URL credentials, query strings, fragments, and secret assignments", () => {
  const redacted = redactString(
    "failed postgresql://app:hunter2@db.internal/wormhole?token=topsecret#frag " +
      "and https://example.com/path?q=private plus password=letmein " +
      "cookie=session123 client_secret=oauthsecret",
  );

  assert.ok(!redacted.includes("hunter2"), redacted);
  assert.ok(!redacted.includes("topsecret"), redacted);
  assert.ok(!redacted.includes("q=private"), redacted);
  assert.ok(!redacted.includes("letmein"), redacted);
  assert.ok(!redacted.includes("session123"), redacted);
  assert.ok(!redacted.includes("oauthsecret"), redacted);
  assert.match(redacted, /postgresql:\/\/db\.internal\/wormhole\?\[REDACTED\]/);
  assert.match(redacted, /https:\/\/example\.com\/path\?\[REDACTED\]/);
});

test("keeps harmless URLs and plain text intact", () => {
  assert.equal(
    redactString("see https://example.com/docs/getting-started for details"),
    "see https://example.com/docs/getting-started for details",
  );
  assert.equal(redactString("database error 57P01"), "database error 57P01");
});

test("serializes errors with name, message, stack, and code", () => {
  const { logger, parse } = capture();
  const error = Object.assign(new Error("connection terminated"), {
    code: "ECONNRESET",
  });

  logger.error("boom", { error });

  const entry = parse()[0] as Record<string, unknown>;
  const serialized = entry.error as Record<string, unknown>;

  assert.equal(serialized.name, "Error");
  assert.equal(serialized.message, "connection terminated");
  assert.equal(serialized.code, "ECONNRESET");
  assert.equal(typeof serialized.stack, "string");
  assert.ok(!("detail" in serialized));
});

test("handles circular and non-Error context values without throwing", () => {
  const { logger, parse } = capture();
  const circular: Record<string, unknown> = { name: "loop" };
  circular.self = circular;

  logger.info("circular", { circular, thrown: "postgres://app:pw@db/x?secret=1" });

  const entry = parse()[0] as Record<string, unknown>;
  const value = entry.circular as Record<string, unknown>;

  assert.equal(value.name, "loop");
  assert.equal(value.self, "[Circular]");
  assert.ok(!JSON.stringify(entry).includes("pw@"));
});
