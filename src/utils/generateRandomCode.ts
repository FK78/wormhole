import { randomBytes } from "crypto";

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

export const generateRandomCode = (length: number): string => {
    const bytes = randomBytes(length)
    let code = ""
    for (let i = 0; i < length; i++) {
        code += ALPHABET[bytes[i]! % ALPHABET.length]
    }
    return code
}