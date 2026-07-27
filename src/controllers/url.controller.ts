import type { Request, Response } from "express";
import { shortenUrl } from "../services/url.service.ts";

export const createUrl = async (req: Request, res: Response) => {
  const url = req.body.url as string
  const result = await shortenUrl(url)
  res.status(200).json(result);
};
