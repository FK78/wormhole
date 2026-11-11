import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import express from "express";
import { errorHandler } from "../../src/middleware/errorHandler.ts";
import { httpObservability } from "../../src/middleware/httpObservability.ts";
import { requestContext } from "../../src/middleware/requestContext.ts";
import { createLogger } from "../../src/observability/logger.ts";
import metricsRoutes from "../../src/routes/metrics.router.ts";

const lines: string[] = [];
const logger = createLogger({
  service: "wormhole-test",
  level: "debug",
  sink: (line) => {
    lines.push(line);
  },
});

const parseLines = (): Array<Record<string, unknown>> =>
  lines.map((line) => JSON.parse(line) as Record<string, unknown>);

let server: Server;
let baseUrl: string;

before(async () => {
  const app = express();

  app.use(requestContext({ logger }));
  app.use(httpObservability());
  app.get("/items/:id", (req, res) => {
    res.json({ id: req.params.id });
  });
  app.get("/teapot", (_req, res) => {
    res.status(418).json({ error: "teapot" });
  });
  app.get("/fail", () => {
    throw new Error(
      "boom postgresql://app:hunter2@db.internal/wormhole?token=topsecret",
    );
  });
  app.use(metricsRoutes);
  app.use(errorHandler);

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

const request = async (route: string, init?: RequestInit) => {
  const response = await fetch(`${baseUrl}${route}`, init);

  // Let the server's response "finish" listener run before assertions.
  await new Promise<void>((resolve) => setTimeout(resolve, 5));

  return response;
};

test("accepts a safe incoming request ID and reflects it in the response", async () => {
  const response = await request("/items/abc123", {
    headers: { "X-Request-ID": "client-request-42" },
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-request-id"), "client-request-42");

  const entry = parseLines().find(
    (line) => line.requestId === "client-request-42",
  );

  assert.ok(entry, `no correlated log entry: ${lines.join("\n")}`);
  assert.equal(entry.level, "info");
  assert.equal(entry.message, "HTTP request completed");
  assert.equal(entry.method, "GET");
  assert.equal(entry.route, "/items/:id");
  assert.equal(entry.status, 200);
  assert.equal(typeof entry.durationMs, "number");
  assert.ok((entry.durationMs as number) >= 0);
});

test("replaces unsafe request IDs with a generated UUID", async () => {
  const unsafe = "x".repeat(129);
  const response = await request("/items/unsafe", {
    headers: { "X-Request-ID": unsafe },
  });

  const requestId = response.headers.get("x-request-id");

  assert.ok(requestId);
  assert.notEqual(requestId, unsafe);
  assert.match(
    requestId!,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  );
});

test("uses route patterns instead of raw paths in access logs and metrics", async () => {
  await request("/items/another-id");

  const entry = parseLines().find(
    (line) => line.route === "/items/:id" && line.requestId !== "client-request-42",
  );

  assert.ok(entry);
  assert.ok(
    !lines.some((line) => line.includes("/items/another-id")),
    "raw short code leaked into logs",
  );

  const metrics = await (await request("/metrics")).text();

  assert.ok(
    metrics.includes(
      'wormhole_http_requests_total{method="GET",route="/items/:id",status="200"}',
    ),
    metrics,
  );
  assert.ok(
    metrics.includes(
      'wormhole_http_request_duration_seconds_count{method="GET",route="/items/:id"}',
    ),
    metrics,
  );
});

test("does not log or count operational probe and scrape traffic", async () => {
  const before = lines.length;

  await request("/healthz");
  await request("/readyz");
  const response = await request("/metrics", {
    headers: { "X-Request-ID": "metrics-scrape-1" },
  });

  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get("content-type"),
    "text/plain; version=0.0.4; charset=utf-8",
  );
  assert.equal(lines.length, before);
  assert.ok(!lines.some((line) => line.includes("metrics-scrape-1")));
});

test("logs unexpected failures at error level with a stack and redacted message", async () => {
  const response = await request("/fail", {
    headers: { "X-Request-ID": "failure-request-1" },
  });

  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "Internal Server Error" });

  const entries = parseLines().filter(
    (line) => line.requestId === "failure-request-1",
  );
  const errorEntry = entries.find(
    (line) => line.message === "unhandled request error",
  );
  const accessEntry = entries.find(
    (line) => line.message === "HTTP request completed",
  );

  assert.ok(errorEntry, `missing error log: ${lines.join("\n")}`);
  assert.equal(errorEntry.level, "error");
  assert.equal(errorEntry.route, "/fail");
  assert.equal(
    typeof (errorEntry.error as Record<string, unknown>).stack,
    "string",
  );

  assert.ok(accessEntry);
  assert.equal(accessEntry.level, "error");
  assert.equal(accessEntry.status, 500);

  const output = entries.map((entry) => JSON.stringify(entry)).join("\n");
  assert.ok(!output.includes("hunter2"), output);
  assert.ok(!output.includes("topsecret"), output);
});

test("logs client errors at warn level", async () => {
  await request("/teapot");

  const entry = parseLines().find((line) => line.route === "/teapot");

  assert.ok(entry);
  assert.equal(entry.level, "warn");
  assert.equal(entry.status, 418);
});

test("labels unmatched routes without logging the raw path", async () => {
  await request("/definitely-not-a-route");

  const entry = parseLines().find(
    (line) => line.route === "unmatched" && line.status === 404,
  );

  assert.ok(entry);
  assert.equal(entry.level, "warn");
  assert.ok(!lines.some((line) => line.includes("definitely-not-a-route")));
});

test("normalizes non-standard HTTP methods to keep metric labels bounded", async () => {
  await request("/teapot", { method: "PROPFIND" });

  const entry = parseLines().find(
    (line) =>
      line.method === "OTHER" &&
      line.route === "unmatched" &&
      line.status === 404,
  );

  assert.ok(entry, lines.join("\n"));
  assert.equal(entry.level, "warn");
});
