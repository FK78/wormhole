import type { Request, Response } from "express";
import { getOriginalUrl, shortenUrl, updateUrl } from "../services/url.service.ts";

export const createUrl = async (req: Request, res: Response) => {
  const url = req.body.url as string
  const result = await shortenUrl(url)
  res.status(201).json(result);
};

export const updateShortUrl = async (req: Request, res: Response) => {
  const url = req.body.url as string
  const shortCode = req.params.id as string
  const result = await updateUrl(url, shortCode)
  res.status(200).json(result);
};

export const retrieveUrl = async (req: Request, res: Response) => {
  const shortCode = req.params.id as string
  const result = await getOriginalUrl(shortCode)
  res.status(200).json(result)
}