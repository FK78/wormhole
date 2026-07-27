import { Router, type Request, type Response } from "express";
import { createUrl, retrieveUrl, updateShortUrl } from "../controllers/url.controller.ts";
import { validate } from "../middleware/validate.ts";

const router = Router();

router.post("/", validate(["url"]), createUrl);
router.put("/:id", validate(["url"]), updateShortUrl);
router.get("/:id", retrieveUrl);

export default router;
