import type { NextFunction, Request, Response } from "express";
import { AppError } from "../errors/AppError.ts";

export const validate =
  (requiredFields: string[]) =>
  (req: Request, res: Response, next: NextFunction) => {
    const missing = requiredFields.filter((f) => !req.body[f]);
    if (missing.length) {
      throw new AppError("Please enter all required fields", 400);
    }
    next();
  };
