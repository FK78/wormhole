import { AppError } from "../errors/AppError.ts";
import { isTransientDbError } from "../db/retry.ts";
import type { NextFunction, Request, Response } from "express";

export const errorHandler = (err: Error, req: Request, res: Response, next: NextFunction) => {
    if (isTransientDbError(err)) {
        const code = (err as NodeJS.ErrnoException).code ?? "unknown";
        console.error(`Database unavailable (${code}): ${err.message}`)
        res.setHeader("Retry-After", "1")
        return res.status(503).json({error: "Service temporarily unavailable"})
    }
    if (err instanceof AppError === false) {
        console.error(`Internal Server Error ${err}`)
        return res.status(500).json({error: "Internal Server Error"})
    }
    return res.status(err.statusCode).json({ error: err.message})
}

export const routeNotFound = (req: Request, res: Response) => {
    res.status(404).json({ error: "Route not found"})
}