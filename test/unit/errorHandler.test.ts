import assert from "node:assert/strict";
import test from "node:test";
import type { NextFunction, Request, Response } from "express";
import { AppError } from "../../src/errors/AppError.ts";
import { createErrorHandler } from "../../src/middleware/errorHandler.ts";
import { createLogger } from "../../src/observability/logger.ts";

const dbError = (code: string) =>
  Object.assign(new Error(`database error: ${code}`), { code });

const makeLogger = () => {
  const lines: string[] = [];
  const logger = createLogger({
    service: "wormhole-test",
    level: "debug",
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    sink: (line) => {
      lines.push(line);
    },
  });

  return { logger, lines };
};

const parseLines = (lines: string[]): Array<Record<string, unknown>> =>
  lines.map((line) => JSON.parse(line) as Record<string, unknown>);

const makeResponse = (locals: Record<string, unknown> = {}) => {
  const headers: Record<string, string> = {};
  const res = {
    statusCode: 200,
    headersSent: false,
    body: undefined as unknown,
    locals,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.body = body;
      return res;
    },
    setHeader(name: string, value: string) {
      headers[name] = value;
      return res;
    },
  };

  return { res: res as unknown as Response, headers };
};

const noopNext = (() => {}) as NextFunction;

test("errorHandler returns 503 with Retry-After for transient database errors", () => {
  const { logger, lines } = makeLogger();
  const { res, headers } = makeResponse({ requestId: "req-1" });

  createErrorHandler({ logger })(
    dbError("57P01"),
    { method: "POST", baseUrl: "/shorten", route: { path: "/" } } as Request,
    res,
    noopNext,
  );

  assert.equal(res.statusCode, 503);
  assert.equal(headers["Retry-After"], "1");
  assert.deepEqual(res.body, { error: "Service temporarily unavailable" });

  const [entry] = parseLines(lines);
  assert.equal(entry?.level, "error");
  assert.equal(entry?.message, "database unavailable while handling request");
  assert.equal(entry?.requestId, "req-1");
  assert.equal(entry?.route, "/shorten");
  assert.deepEqual(
    { name: (entry?.error as Record<string, unknown>).name },
    { name: "Error" },
  );
});

test("errorHandler keeps returning 500 for unknown errors and logs a stack", () => {
  const { logger, lines } = makeLogger();
  const { res } = makeResponse({ requestId: "req-2" });

  createErrorHandler({ logger })(
    new Error("boom"),
    { method: "GET", baseUrl: "", route: { path: "/healthz" } } as Request,
    res,
    noopNext,
  );

  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { error: "Internal Server Error" });

  const [entry] = parseLines(lines);
  assert.equal(entry?.level, "error");
  assert.equal(entry?.message, "unhandled request error");
  assert.equal(entry?.requestId, "req-2");
  assert.equal(typeof (entry?.error as Record<string, unknown>).stack, "string");
});

test("errorHandler still returns AppError status codes", () => {
  const { logger, lines } = makeLogger();
  const { res } = makeResponse({ requestId: "req-3" });

  createErrorHandler({ logger })(
    new AppError("Failed to find URL", 404),
    { method: "GET", baseUrl: "/shorten", route: { path: "/:id" } } as Request,
    res,
    noopNext,
  );

  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, { error: "Failed to find URL" });

  const [entry] = parseLines(lines);
  assert.equal(entry?.level, "debug");
  assert.equal(entry?.message, "request rejected");
  assert.equal(entry?.status, 404);
});

test("error logs redact credentials and query data from error messages", () => {
  const { logger, lines } = makeLogger();
  const { res } = makeResponse();

  const error = Object.assign(
    new Error(
      "connect ECONNREFUSED postgresql://app:hunter2@db.internal:5432/wormhole?token=topsecret",
    ),
    { code: "ECONNREFUSED" },
  );

  createErrorHandler({ logger })(
    error,
    { method: "POST", baseUrl: "/shorten", route: { path: "/" } } as Request,
    res,
    noopNext,
  );

  const output = lines.join("\n");
  assert.ok(!output.includes("hunter2"), `leaked password: ${output}`);
  assert.ok(!output.includes("topsecret"), `leaked token: ${output}`);
  assert.match(output, /\[REDACTED\]/);
});

test("errorHandler delegates when headers are already sent", () => {
  const { logger, lines } = makeLogger();
  const { res } = makeResponse();
  res.headersSent = true;
  const received: unknown[] = [];

  createErrorHandler({ logger })(
    new Error("late failure"),
    {} as Request,
    res,
    ((err: unknown) => {
      received.push(err);
    }) as NextFunction,
  );

  assert.equal(received.length, 1);
  assert.equal(lines.length, 0);
});
