import type { NextFunction, Request, Response } from "express";

/**
 * Captures the mount path while Express still has it on `req.baseUrl`.
 * Express restores `req.baseUrl` when a router finishes, so reading it from a
 * response "finish" listener can be too late for error responses.
 */
export const captureRouteBase = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  res.locals.routeBaseUrl = req.baseUrl;
  next();
};

/**
 * Returns a bounded-cardinality label for the matched route, for example
 * `/shorten/:id`. Raw paths are never used because short codes are unbounded
 * and would create one metric series per URL.
 */
export const getRouteLabel = (req: Request, res: Response): string => {
  const route = req.route as { path?: unknown } | undefined;
  const routePath =
    route && typeof route.path === "string" ? route.path : undefined;

  if (!routePath) return "unmatched";

  const capturedBaseUrl = res.locals.routeBaseUrl;
  const baseUrl =
    typeof capturedBaseUrl === "string" ? capturedBaseUrl : req.baseUrl;
  const label = `${baseUrl}${routePath}`;
  const normalized = label.length > 1 ? label.replace(/\/+$/, "") : label;

  return normalized || "/";
};

const KNOWN_METHODS = new Set([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
]);

/**
 * Keeps the method label bounded when clients send non-standard methods.
 */
export const getMethodLabel = (method: string): string =>
  KNOWN_METHODS.has(method) ? method : "OTHER";

const OPERATIONAL_PATHS = new Set(["/healthz", "/readyz", "/metrics"]);

/**
 * Probes and scrapes would otherwise dominate request counts and dilute the
 * user-facing error rate, so they are excluded from access logs and RED
 * metrics. Database outages are covered by the dedicated availability alert.
 */
export const isOperationalRequest = (req: Request): boolean => {
  const path =
    req.path.length > 1 && req.path.endsWith("/")
      ? req.path.slice(0, -1)
      : req.path;

  return OPERATIONAL_PATHS.has(path);
};
