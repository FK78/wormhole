import type { NextFunction, Request, Response } from "express";

export const validate =
  (requiredFields: string[]) =>
  (req: Request, res: Response, next: NextFunction) => {
    const missing = requiredFields.filter((f) => !req.body[f]);
    if (missing.length) {
      return res
        .status(400)
        .json({ error: "Please enter all required fields" });
    }
    next();
  };
