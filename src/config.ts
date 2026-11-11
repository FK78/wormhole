import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export type Env = Record<string, string | undefined>;

export type DatabaseConfig = {
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
    connectTimeoutMs: number;
};

export type Config = {
    httpPort: number;
    shutdownTimeoutMs: number;
    database: DatabaseConfig;
};

export class ConfigError extends Error {
    readonly issues: readonly string[];

    constructor(issues: readonly string[]) {
        super(
            [
                "Invalid configuration:",
                ...issues.map((issue) => `  - ${issue}`),
                "",
                "See .env.example and README.md for the expected variables.",
            ].join("\n"),
        );
        this.name = "ConfigError";
        this.issues = issues;
    }
}

const DEFAULT_HTTP_PORT = 3_000;
const DEFAULT_HOST = "localhost";
const DEFAULT_POSTGRES_PORT = 5_432;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;
const DEFAULT_DB_CONNECT_TIMEOUT_MS = 5_000;

// setTimeout() treats anything larger as 1ms and emits a warning.
const MAX_TIMER_MS = 2_147_483_647;

const isSet = (value: string | undefined): value is string =>
    value !== undefined && value.trim() !== "";

const requiredString = (
    env: Env,
    name: string,
    issues: string[],
): string | undefined => {
    const value = env[name];

    if (value === undefined) {
        issues.push(`${name} is required`);
        return undefined;
    }

    const trimmed = value.trim();
    if (trimmed === "") {
        issues.push(`${name} must not be empty`);
        return undefined;
    }

    return trimmed;
};

const optionalString = (env: Env, name: string, fallback: string): string =>
    isSet(env[name]) ? env[name].trim() : fallback;

const parseInteger = (
    env: Env,
    name: string,
    issues: string[],
    options: { fallback?: number; min: number; max: number },
): number | undefined => {
    const raw = env[name];

    // An empty optional value falls back to the default instead of being
    // coerced by Number(), which would turn "" into 0.
    if (!isSet(raw)) return options.fallback;

    const text = raw.trim();
    const value = /^\d+$/.test(text) ? Number(text) : Number.NaN;

    if (
        !Number.isSafeInteger(value) ||
        value < options.min ||
        value > options.max
    ) {
        issues.push(
            `${name} must be an integer between ${options.min} and ${options.max} (received "${raw}")`,
        );
        return undefined;
    }

    return value;
};

const readPassword = (env: Env, issues: string[]): string | undefined => {
    const password = env.POSTGRES_PASSWORD;
    const passwordFile = env.POSTGRES_PASSWORD_FILE;

    if (isSet(password)) {
        issues.push(
            isSet(passwordFile)
                ? "POSTGRES_PASSWORD and POSTGRES_PASSWORD_FILE are both set; use only POSTGRES_PASSWORD_FILE"
                : "POSTGRES_PASSWORD is not supported; set POSTGRES_PASSWORD_FILE to a file containing the password",
        );
        return undefined;
    }

    if (!isSet(passwordFile)) {
        issues.push(
            passwordFile === undefined
                ? "POSTGRES_PASSWORD_FILE is required"
                : "POSTGRES_PASSWORD_FILE must not be empty",
        );
        return undefined;
    }

    const filePath = resolve(passwordFile.trim());
    let contents: string;

    try {
        contents = readFileSync(filePath, "utf8");
    } catch (err) {
        const code = (err as NodeJS.ErrnoException).code ?? "unknown";
        issues.push(
            `POSTGRES_PASSWORD_FILE: cannot read "${filePath}" (${code}); create it with the database password`,
        );
        return undefined;
    }

    // Match how PostgreSQL's entrypoint reads POSTGRES_PASSWORD_FILE: strip
    // trailing newlines from the file, but keep any other whitespace so the
    // app and the container use the exact same password.
    const value = contents.replace(/\n+$/, "");

    if (value.trim() === "") {
        issues.push(`POSTGRES_PASSWORD_FILE: "${filePath}" is empty`);
        return undefined;
    }

    return value;
};

export const loadConfig = (env: Env = process.env): Config => {
    const issues: string[] = [];

    if (isSet(env.DATABASE_URL)) {
        issues.push(
            "DATABASE_URL is not supported; configure the database with POSTGRES_USER, POSTGRES_DB, HOST, POSTGRES_PORT, and POSTGRES_PASSWORD_FILE",
        );
    }

    const httpPort = parseInteger(env, "WORMHOLE_PORT", issues, {
        fallback: DEFAULT_HTTP_PORT,
        min: 1,
        max: 65_535,
    });
    const postgresPort = parseInteger(env, "POSTGRES_PORT", issues, {
        fallback: DEFAULT_POSTGRES_PORT,
        min: 1,
        max: 65_535,
    });
    const shutdownTimeoutMs = parseInteger(env, "SHUTDOWN_TIMEOUT_MS", issues, {
        fallback: DEFAULT_SHUTDOWN_TIMEOUT_MS,
        min: 1,
        max: MAX_TIMER_MS,
    });
    const connectTimeoutMs = parseInteger(env, "DB_CONNECT_TIMEOUT_MS", issues, {
        fallback: DEFAULT_DB_CONNECT_TIMEOUT_MS,
        min: 1,
        max: MAX_TIMER_MS,
    });

    const user = requiredString(env, "POSTGRES_USER", issues);
    const database = requiredString(env, "POSTGRES_DB", issues);
    const password = readPassword(env, issues);
    const host = optionalString(env, "HOST", DEFAULT_HOST);

    if (issues.length > 0) {
        throw new ConfigError(issues);
    }

    return {
        httpPort: httpPort!,
        shutdownTimeoutMs: shutdownTimeoutMs!,
        database: {
            host,
            port: postgresPort!,
            user: user!,
            password: password!,
            database: database!,
            connectTimeoutMs: connectTimeoutMs!,
        },
    };
};
