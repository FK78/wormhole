import { Router } from "express";
import { healthz, readyz } from "../controllers/health.controller.ts";

const router = Router();

router.get("/healthz", healthz);
router.get("/readyz", readyz);

export default router;
