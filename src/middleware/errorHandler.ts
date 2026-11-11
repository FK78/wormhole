import type { ErrorRequestHandler, Request, Response } from "express";
import { AppError } from "../errors/AppError.ts";
import { isTransientDbError } from "../db/retry.ts";
import { getRouteLabel } from "../observability/http.ts";
import { getLogger, type Logger } from "../observability/logger.ts";
import { getRequestId, getRequestLogger } from "./requestContext.ts";

type ErrorHandlerOptions = {
  logger?: Logger;
};

/**
 * Error logs contain the stack and bounded request context, never request
 * bodies, headers, query strings, or pg's row-level error fields.
 */
export const createErrorHandler = (
  options: ErrorHandlerOptions = {},
): ErrorRequestHandler => {
  return (err, req, res, next) => {
    if (res.headersSent) {
      return next(err);
    }

    const logger = options.logger ?? getRequestLogger(res);
    const context = {
      requestId: getRequestId(res),
      method: req.method,
      route: getRouteLabel(req, res),
    };

    if (isTransientDbError(err)) {
      const code = (err as NodeJS.ErrnoException).code ?? "unknown";

      logger.error("database unavailable while handling request", {
        ...context,
        status: 503,
        errorCode: code,
        error: err,
      });

      res.setHeader("Retry-After", "1");
      return res.status(503).json({ error: "Service temporarily unavailable" });
    }

    if (!(err instanceof AppError)) {
      logger.error("unhandled request error", {
        ...context,
        status: 500,
        error: err,
      });

      return res.status(500).json({ error: "Internal Server Error" });
    }

    if (err.statusCode >= 500) {
      logger.error("request failed", {
        ...context,
        status: err.statusCode,
        error: err,
      });
    } else {
      // Access logs already record expected client errors at warn level.
      // Keep this at debug so 404s do not become error-level noise.
      logger.debug("request rejected", {
        ...context,
        status: err.statusCode,
        errorMessage: err.message,
      });
    }

    return res.status(err.statusCode).json({ error: err.message });
  };
};

export const errorHandler = createErrorHandler();

export const routeNotFound = (_req: Request, res: Response) => {
  res.status(404).json({ error: "Route not found" });
};
