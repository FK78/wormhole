import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import express from "express";
import { pool } from "../../src/db/db.ts";
import healthRoutes from "../../src/routes/health.router.ts";
import {
  isDatabaseReady,
  READINESS_TIMEOUT_MS,
} from "../../src/services/health.service.ts";

const packageJson = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { version: string };

type Body = {
  status: string;
  version: string;
  commit: string;
  uptimeSeconds: number;
  checks?: { database: string };
};

type TestResponse = {
  status: number;
  headers: Headers;
  text: string;
  body: Body;
};

let server: Server;
let baseUrl: string;

const request = async (route: string): Promise<TestResponse> => {
  const response = await fetch(`${baseUrl}${route}`);
  const text = await response.text();

  return {
    status: response.status,
    headers: response.headers,
    text,
    body: (text ? JSON.parse(text) : undefined) as Body,
  };
};

before(async () => {
  const app = express();
  app.use(healthRoutes);

  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });

  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("GET /healthz reports liveness without touching the database", async (t) => {
  const query = t.mock.method(pool, "query", async () => ({ rows: [] }));

  const response = await request("/healthz");

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.body.status, "ok");
  assert.equal(response.body.version, packageJson.version);
  assert.equal(response.body.commit, process.env.GIT_COMMIT ?? "unknown");
  assert.equal(typeof response.body.uptimeSeconds, "number");
  assert.equal(query.mock.callCount(), 0);
});

test("GET /readyz returns 200 when the database responds", async (t) => {
  const query = t.mock.method(pool, "query", async () => ({
    rows: [{ "?column?": 1 }],
  }));

  const response = await request("/readyz");

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.body.status, "ready");
  assert.deepEqual(response.body.checks, { database: "ok" });
  assert.equal(query.mock.callCount(), 1);
  assert.deepEqual(query.mock.calls[0]?.arguments[0], {
    text: "SELECT 1",
    query_timeout: READINESS_TIMEOUT_MS,
  });
});

test("GET /readyz returns 503 when the database is down without leaking details", async (t) => {
  const error = Object.assign(
    new Error(
      "connect ECONNREFUSED db.internal:5432 postgresql://postgres:hunter2@db.internal/wormhole",
    ),
    { code: "ECONNREFUSED" },
  );
  t.mock.method(pool, "query", async () => {
    throw error;
  });

  const response = await request("/readyz");

  assert.equal(response.status, 503);
  assert.equal(response.headers.get("retry-after"), "1");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.body.status, "unavailable");
  assert.deepEqual(response.body.checks, { database: "unavailable" });

  for (const leak of [
    "ECONNREFUSED",
    "hunter2",
    "postgresql://",
    "db.internal",
    "stack",
  ]) {
    assert.ok(
      !response.text.includes(leak),
      `/readyz response leaked "${leak}": ${response.text}`,
    );
  }
});

test("GET /readyz recovers automatically once the database returns", async (t) => {
  let databaseUp = false;
  t.mock.method(pool, "query", async () => {
    if (!databaseUp) throw new Error("connect ECONNREFUSED");

    return { rows: [{ "?column?": 1 }] };
  });

  const duringOutage = await request("/readyz");
  assert.equal(duringOutage.status, 503);

  databaseUp = true;

  const recovered = await request("/readyz");
  assert.equal(recovered.status, 200);
  assert.deepEqual(recovered.body.checks, { database: "ok" });
});

test("GET /healthz stays live while the database is down", async (t) => {
  const query = t.mock.method(pool, "query", async () => {
    throw new Error("database is down");
  });

  const response = await request("/healthz");

  assert.equal(response.status, 200);
  assert.equal(response.body.status, "ok");
  assert.equal(query.mock.callCount(), 0);
});

test("isDatabaseReady enforces a short timeout", async (t) => {
  const query = t.mock.method(pool, "query", () => new Promise(() => {}));

  const startedAt = Date.now();
  const ready = await isDatabaseReady(50);
  const elapsedMs = Date.now() - startedAt;

  assert.equal(ready, false);
  assert.ok(elapsedMs >= 40, `timed out too early: ${elapsedMs}ms`);
  assert.ok(elapsedMs < 1_000, `timeout took too long: ${elapsedMs}ms`);

  // pg must also time the query out so the checked-out client is released
  // instead of being leaked by the abandoned Promise.race below.
  assert.deepEqual(query.mock.calls[0]?.arguments[0], {
    text: "SELECT 1",
    query_timeout: 50,
  });
});
