import type { Request, Response } from "express";
import { isDatabaseReady } from "../services/health.service.ts";
import { buildInfo } from "../utils/buildInfo.ts";

const uptimeSeconds = () => Math.round(process.uptime());

export const healthz = (_req: Request, res: Response) => {
  res.set("Cache-Control", "no-store");
  res.status(200).json({
    status: "ok",
    ...buildInfo,
    uptimeSeconds: uptimeSeconds(),
  });
};

export const readyz = async (_req: Request, res: Response) => {
  const ready = await isDatabaseReady();

  res.set("Cache-Control", "no-store");

  if (!ready) {
    res.set("Retry-After", "1");
    return res.status(503).json({
      status: "unavailable",
      ...buildInfo,
      uptimeSeconds: uptimeSeconds(),
      checks: { database: "unavailable" },
    });
  }

  return res.status(200).json({
    status: "ready",
    ...buildInfo,
    uptimeSeconds: uptimeSeconds(),
    checks: { database: "ok" },
  });
};
