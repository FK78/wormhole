import { Router } from "express";
import { createUrl, removeUrl, retrieveUrl, retrieveUrlStats, updateShortUrl } from "../controllers/url.controller.ts";
import { validate } from "../middleware/validate.ts";

const router = Router();

router.post("/", validate(["url"]), createUrl);
router.put("/:id", validate(["url"]), updateShortUrl);
router.get("/:id", retrieveUrl);
router.get("/:id/stats", retrieveUrlStats);
router.delete("/:id", removeUrl)

export default router;
