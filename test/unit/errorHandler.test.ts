import assert from "node:assert/strict";
import test from "node:test";
import type { NextFunction, Request, Response } from "express";
import { errorHandler } from "../../src/middleware/errorHandler.ts";
import { AppError } from "../../src/errors/AppError.ts";

const dbError = (code: string) =>
  Object.assign(new Error(`database error: ${code}`), { code });

const makeResponse = () => {
  const headers: Record<string, string> = {};
  const res = {
    statusCode: 200,
    body: undefined as unknown,
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

test("errorHandler returns 503 with Retry-After for transient database errors", (t) => {
  t.mock.method(console, "error", () => {});
  const { res, headers } = makeResponse();

  errorHandler(
    dbError("57P01"),
    {} as Request,
    res,
    noopNext,
  );

  assert.equal(res.statusCode, 503);
  assert.equal(headers["Retry-After"], "1");
  assert.deepEqual(res.body, { error: "Service temporarily unavailable" });
});

test("errorHandler keeps returning 500 for unknown errors", (t) => {
  t.mock.method(console, "error", () => {});
  const { res } = makeResponse();

  errorHandler(new Error("boom"), {} as Request, res, noopNext);

  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { error: "Internal Server Error" });
});

test("errorHandler still returns AppError status codes", (t) => {
  t.mock.method(console, "error", () => {});
  const { res } = makeResponse();

  errorHandler(new AppError("Failed to find URL", 404), {} as Request, res, noopNext);

  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, { error: "Failed to find URL" });
});
