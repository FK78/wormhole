import { insertShortLink } from "../queries/url.queries.ts";
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
