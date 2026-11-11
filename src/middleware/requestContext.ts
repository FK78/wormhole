import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import {
  getLogger,
  getRootLogger,
  runWithRequestLogContext,
  type Logger,
} from "../observability/logger.ts";

export const REQUEST_ID_HEADER = "x-request-id";

// Reject untrusted values that could break log parsing or inject lines.
const VALID_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export const getRequestId = (res: Response): string | undefined =>
  res.locals.requestId as string | undefined;

export const getRequestLogger = (res: Response): Logger =>
  (res.locals.logger as Logger | undefined) ?? getLogger();

export const requestContext =
  (options: { logger?: Logger } = {}) =>
  (req: Request, res: Response, next: NextFunction): void => {
    const incoming = req.get(REQUEST_ID_HEADER);
    const requestId =
      incoming && VALID_REQUEST_ID.test(incoming) ? incoming : randomUUID();
    const baseLogger = options.logger ?? getRootLogger();
    const logger = baseLogger.child({ requestId });

    res.locals.requestId = requestId;
    res.locals.logger = logger;
    res.setHeader("X-Request-ID", requestId);

    runWithRequestLogContext({ requestId, logger }, next);
  };
