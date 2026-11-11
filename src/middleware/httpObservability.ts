import type { NextFunction, Request, Response } from "express";
import {
  getMethodLabel,
  getRouteLabel,
  isOperationalRequest,
} from "../observability/http.ts";
import { getLogger, type Logger } from "../observability/logger.ts";
import {
  httpRequestDurationSeconds,
  httpRequestsTotal,
} from "../observability/metrics.ts";

const roundMilliseconds = (seconds: number): number =>
  Math.round(seconds * 1_000_000) / 1_000;

export const httpObservability =
  (options: { logger?: Logger } = {}) =>
  (req: Request, res: Response, next: NextFunction): void => {
    const startedAt = process.hrtime.bigint();

    res.on("finish", () => {
      // Probes and scrapes must not log themselves or inflate RED metrics.
      if (isOperationalRequest(req)) return;

      const durationSeconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
      const method = getMethodLabel(req.method);
      const route = getRouteLabel(req, res);
      const status = res.statusCode;
      const logger =
        (res.locals.logger as Logger | undefined) ??
        options.logger ??
        getLogger();

      httpRequestsTotal.increment({
        method,
        route,
        status: String(status),
      });
      httpRequestDurationSeconds.observe(durationSeconds, { method, route });

      const entry = {
        requestId: res.locals.requestId as string | undefined,
        method,
        route,
        status,
        durationMs: roundMilliseconds(durationSeconds),
      };

      if (status >= 500) {
        logger.error("HTTP request completed", entry);
      } else if (status >= 400) {
        logger.warn("HTTP request completed", entry);
      } else {
        logger.info("HTTP request completed", entry);
      }
    });

    next();
  };
