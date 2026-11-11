import { Router } from "express";
import { renderMetrics } from "../observability/metrics.ts";

const router = Router();

router.get("/metrics", (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.set("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
  res.send(renderMetrics());
});

export default router;
