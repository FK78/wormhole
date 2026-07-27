import { AppError } from "../errors/AppError.ts";
import { getUrl, insertShortLink } from "../queries/url.queries.ts";
import { generateRandomCode } from "../utils/generateRandomCode.ts";

type urlRow = {
    id: string,
    url: string,
    short_code: string,
    access_count?: number,
    created_at: Date,
    updated_at: Date
}

type urlRecord = {
    id: string,
    url: string,
    shortCode: string,
    accessCount?: number,
    createdAt: Date,
    updatedAt: Date
}

const mapRow = (row: urlRow): urlRecord => ({
    id: row.id,
    url: row.url,
    shortCode: row.short_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.access_count !== undefined && { accessCount: row.access_count })

})

export const shortenUrl = async (originalUrl: string) => {
    for (let attempt = 0; attempt < 5; attempt++) {
        const shortCode = generateRandomCode(6);
        try {
            const result = await insertShortLink(originalUrl, shortCode);
            return result;
        } catch (err: any) {
            if ((err.code == "23505")) continue;
            throw err;
        }
    }
    throw new Error("Failed to generate unique short code after retries")
};

export const getOriginalUrl = async (shortCode: string) => {
    const result = await getUrl(shortCode)
    if (!result) {
        throw new AppError("Failed to find URL", 404)
    }
    const row = result
    return row ? mapRow(row) : null
}