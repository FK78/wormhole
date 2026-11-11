import { AsyncLocalStorage } from "node:async_hooks";

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogContext = Record<string, unknown>;

export type LogSink = (line: string, level: LogLevel) => void;

export type Logger = {
  readonly level: LogLevel;
  child(context: LogContext): Logger;
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
};

type LoggerOptions = {
  service?: string;
  level?: LogLevel;
  context?: LogContext;
  sink?: LogSink;
  now?: () => Date;
};

type LoggerSettings = {
  service: string;
  level: LogLevel;
  sink: LogSink;
  now: () => Date;
};

const LEVEL_VALUES: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const DEFAULT_SERVICE = "wormhole";
const MAX_CONTEXT_DEPTH = 6;

// Keys whose values must never be written to a log line. Matching is
// case-insensitive and applies at every nesting level.
const SENSITIVE_KEY =
  /pass(?:word|wd)?|secret|token|api[-_]?key|authorization|cookie|credential|session|private[-_]?key|client[-_]?secret/i;

// Textual secrets that can appear inside otherwise safe string fields, such
// as an Error message produced by pg or the HTTP stack.
const SECRET_ASSIGNMENT =
  /\b(password|passwd|pwd|secret|token|access[_-]?token|refresh[_-]?token|api[_-]?key|client[_-]?secret|key|authorization|cookie|credential|session)\b(\s*[:=]\s*)(["']?)([^\s,;"'&]+)\3/gi;

const AUTHENTICATION_HEADER =
  /\b(authorization|proxy-authorization)\s*[:=]\s*(?:bearer|basic)?\s*[^\s,;]+/gi;

const SECRET_QUERY_PARAM =
  /([?&](?:password|passwd|pwd|secret|token|access_token|refresh_token|api[_-]?key|key|signature|sig|auth|authorization|session|cookie)=)[^&#\s"'<>]*/gi;

// scheme://[userinfo@]host[:port]/path?query#fragment
const URL_PATTERN =
  /\b[a-z][a-z0-9+.-]*:\/\/(?:[^@/\s"'<>]+@)?[^\s"'<>]*/gi;

const stripTrailingPunctuation = (value: string): {
  url: string;
  trailing: string;
} => {
  const trailing = value.match(/[),.;!?]+$/)?.[0] ?? "";

  return {
    url: trailing ? value.slice(0, -trailing.length) : value,
    trailing,
  };
};

const redactUrl = (value: string): string => {
  const { url, trailing } = stripTrailingPunctuation(value);
  const match = url.match(
    /^([a-z][a-z0-9+.-]*:\/\/)(?:[^@/\s]*@)?([^/?#\s]*)([^?#\s]*)(\?[^#\s]*)?(#\S*)?$/i,
  );

  if (!match) return `[REDACTED_URL]${trailing}`;

  const [, scheme = "", host = "", path = "", query, hash] = match;
  const safeQuery = query ? "?[REDACTED]" : "";
  const safeHash = hash ? "#[REDACTED]" : "";

  return `${scheme}${host}${path}${safeQuery}${safeHash}${trailing}`;
};

/**
 * Removes credentials and query/fragment data from any URL-like text, and
 * redacts well-known secret assignments. Query strings are removed wholesale
 * because arbitrary short-link URLs can carry secrets under any parameter
 * name, not just the ones we recognize.
 */
export const redactString = (input: string): string =>
  input
    .replace(URL_PATTERN, redactUrl)
    .replace(SECRET_QUERY_PARAM, "$1[REDACTED]")
    .replace(AUTHENTICATION_HEADER, "$1: [REDACTED]")
    .replace(SECRET_ASSIGNMENT, (_match, key: string, separator: string) =>
      `${key}${separator}[REDACTED]`,
    );

const sanitizeValue = (
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
): unknown => {
  if (value === null || value === undefined) return value;

  switch (typeof value) {
    case "string":
      return redactString(value);
    case "number":
    case "boolean":
      return value;
    case "bigint":
      return value.toString();
    case "function":
    case "symbol":
      return String(value);
    case "object":
      break;
  }

  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return serializeError(value);
  if (depth >= MAX_CONTEXT_DEPTH) return "[MaxDepth]";
  if (seen.has(value)) return "[Circular]";

  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, depth + 1, seen));
  }

  const output: Record<string, unknown> = {};

  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    output[key] = SENSITIVE_KEY.test(key)
      ? "[REDACTED]"
      : sanitizeValue(item, depth + 1, seen);
  }

  return output;
};

export const serializeError = (error: unknown): Record<string, unknown> => {
  if (!(error instanceof Error)) {
    return { value: sanitizeValue(error, 0, new WeakSet()) };
  }

  const serialized: Record<string, unknown> = {
    name: error.name,
    message: redactString(error.message),
  };

  if (error.stack) {
    serialized.stack = redactString(error.stack);
  }

  const code = (error as NodeJS.ErrnoException).code;
  if (typeof code === "string" || typeof code === "number") {
    serialized.code = code;
  }

  // Deliberately do not copy pg's `detail`, `hint`, or `where` fields: they
  // can contain row values, including the URLs users submitted.
  return serialized;
};

const sanitizeContext = (context: LogContext): Record<string, unknown> =>
  sanitizeValue(context, 0, new WeakSet()) as Record<string, unknown>;

const writeToStream: LogSink = (line, level) => {
  const stream = level === "warn" || level === "error"
    ? process.stderr
    : process.stdout;

  try {
    stream.write(`${line}\n`);
  } catch {
    // Logging must never take the process down, even when the stream is gone.
  }
};

let settings: LoggerSettings = {
  service: DEFAULT_SERVICE,
  level: "info",
  sink: writeToStream,
  now: () => new Date(),
};

const createLoggerFrom = (
  current: LoggerSettings,
  context: Record<string, unknown>,
): Logger => {
  const shouldLog = (level: LogLevel): boolean =>
    LEVEL_VALUES[level] >= LEVEL_VALUES[current.level];

  const write = (level: LogLevel, message: string, extra?: LogContext): void => {
    if (!shouldLog(level)) return;

    const entry: Record<string, unknown> = {
      ...context,
      ...(extra ? sanitizeContext(extra) : {}),
      timestamp: current.now().toISOString(),
      level,
      service: current.service,
      message: redactString(message),
    };

    let line: string;

    try {
      line = JSON.stringify(entry);
    } catch {
      line = JSON.stringify({
        timestamp: current.now().toISOString(),
        level,
        service: current.service,
        message: redactString(message),
        logSerializationError: true,
      });
    }

    current.sink(line, level);
  };

  return {
    level: current.level,
    child(childContext) {
      return createLoggerFrom(current, {
        ...context,
        ...sanitizeContext(childContext),
      });
    },
    debug: (message, extra) => write("debug", message, extra),
    info: (message, extra) => write("info", message, extra),
    warn: (message, extra) => write("warn", message, extra),
    error: (message, extra) => write("error", message, extra),
  };
};

let rootLogger = createLoggerFrom(settings, {});

type RequestLogStore = {
  requestId: string;
  logger: Logger;
};

const requestStorage = new AsyncLocalStorage<RequestLogStore>();

/**
 * Runs `callback` with a request-scoped logger. Async work started inside the
 * callback inherits it, so database and service log lines carry the same
 * request ID as the access log entry.
 */
export const runWithRequestLogContext = <T>(
  store: RequestLogStore,
  callback: () => T,
): T => requestStorage.run(store, callback);

export const getLogger = (): Logger =>
  requestStorage.getStore()?.logger ?? rootLogger;

export const getRootLogger = (): Logger => rootLogger;

/**
 * Reconfigures the process-wide logger. Call once after configuration has
 * been validated; loggers created earlier keep their own settings.
 */
export const configureLogger = (options: {
  service?: string;
  level?: LogLevel;
  sink?: LogSink;
  now?: () => Date;
}): Logger => {
  settings = {
    service: options.service ?? settings.service,
    level: options.level ?? settings.level,
    sink: options.sink ?? settings.sink,
    now: options.now ?? settings.now,
  };
  rootLogger = createLoggerFrom(settings, {});

  return rootLogger;
};

/** Creates an independent logger, primarily for tests and one-off scripts. */
export const createLogger = (options: LoggerOptions = {}): Logger =>
  createLoggerFrom(
    {
      service: options.service ?? settings.service,
      level: options.level ?? settings.level,
      sink: options.sink ?? settings.sink,
      now: options.now ?? settings.now,
    },
    sanitizeContext(options.context ?? {}),
  );
