import { AppError } from "../errors/AppError.ts";
import { deleteUrlRow, getUrl, getUrlStats, insertShortLink, updateOriginalUrl } from "../queries/url.queries.ts";
import { generateRandomCode } from "../utils/generateRandomCode.ts";

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
    return result
}

export const getShortCodeUrlStats = async (shortCode: string) => {
    const result = await getUrlStats(shortCode)
    if (!result) {
        throw new AppError("Failed to find URL", 404)
    }
    return result
}

export const updateUrl = async (url: string, shortCode: string) => {
    const result = await updateOriginalUrl(url, shortCode)
    if (!result){
        throw new AppError("Failed to find URL", 404)
    }
    return result
}

export const deleteUrl = async (shortCode: string) => {
    const result = await deleteUrlRow(shortCode)
    if (result.rowCount === 0){
        throw new AppError("Failed to find URL", 404)
    }
}