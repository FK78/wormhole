import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import {
  ConfigError,
  loadConfig,
  loadDatabaseConfig,
  loadLogLevel,
} from "../../src/config.ts";
import type { Env } from "../../src/config.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

const tempRoot = mkdtempSync(path.join(tmpdir(), "wormhole-config-"));

after(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

const passwordFile = (contents: string, name = "postgres_password.txt") => {
  const dir = mkdtempSync(path.join(tempRoot, "case-"));
  const file = path.join(dir, name);
  writeFileSync(file, contents);
  return file;
};

const baseEnv = (file: string): Env => ({
  POSTGRES_USER: "postgres",
  POSTGRES_DB: "wormhole",
  POSTGRES_PASSWORD_FILE: file,
});

const loadAndExpectError = (env: Env): ConfigError => {
  try {
    loadConfig(env);
  } catch (err) {
    assert.ok(
      err instanceof ConfigError,
      `expected ConfigError, got ${String(err)}`,
    );
    return err;
  }

  assert.fail("expected loadConfig to throw");
};

test("loads a valid configuration with documented defaults", () => {
  const file = passwordFile("s3cret\n");

  const config = loadConfig(baseEnv(file));

  assert.equal(config.httpPort, 3_000);
  assert.equal(config.shutdownTimeoutMs, 10_000);
  assert.equal(config.dbHealthCheckIntervalMs, 5_000);
  assert.equal(config.logLevel, "info");
  assert.equal(config.runMigrationsOnStartup, false);
  assert.deepEqual(config.database, {
    host: "localhost",
    port: 5_432,
    user: "postgres",
    password: "s3cret",
    database: "wormhole",
    connectTimeoutMs: 5_000,
  });
});

test("uses explicit values", () => {
  const file = passwordFile("s3cret");

  const config = loadConfig({
    ...baseEnv(file),
    WORMHOLE_PORT: "8080",
    SHUTDOWN_TIMEOUT_MS: "2500",
    DB_CONNECT_TIMEOUT_MS: "1500",
    DB_HEALTH_CHECK_INTERVAL_MS: "15000",
    LOG_LEVEL: "DEBUG",
    RUN_MIGRATIONS_ON_STARTUP: "TRUE",
    HOST: "db.internal",
    POSTGRES_PORT: "6543",
  });

  assert.equal(config.httpPort, 8_080);
  assert.equal(config.shutdownTimeoutMs, 2_500);
  assert.equal(config.dbHealthCheckIntervalMs, 15_000);
  assert.equal(config.logLevel, "debug");
  assert.equal(config.runMigrationsOnStartup, true);
  assert.deepEqual(config.database, {
    host: "db.internal",
    port: 6_543,
    user: "postgres",
    password: "s3cret",
    database: "wormhole",
    connectTimeoutMs: 1_500,
  });
});

test("empty optional values fall back to defaults instead of zero", () => {
  const file = passwordFile("s3cret");

  const config = loadConfig({
    ...baseEnv(file),
    WORMHOLE_PORT: "",
    SHUTDOWN_TIMEOUT_MS: "",
    DB_CONNECT_TIMEOUT_MS: "",
    DB_HEALTH_CHECK_INTERVAL_MS: "",
    LOG_LEVEL: "  ",
    HOST: "   ",
    POSTGRES_PORT: "",
  });

  assert.equal(config.httpPort, 3_000);
  assert.equal(config.shutdownTimeoutMs, 10_000);
  assert.equal(config.dbHealthCheckIntervalMs, 5_000);
  assert.equal(config.logLevel, "info");
  assert.equal(config.database.connectTimeoutMs, 5_000);
  assert.equal(config.database.host, "localhost");
  // Number("") === 0 used to make this port 0.
  assert.equal(config.database.port, 5_432);
});

test("reports every missing required variable at once", () => {
  const error = loadAndExpectError({});

  assert.match(error.message, /POSTGRES_USER is required/);
  assert.match(error.message, /POSTGRES_DB is required/);
  assert.match(error.message, /POSTGRES_PASSWORD_FILE is required/);
  assert.match(error.message, /See \.env\.example and README\.md/);
});

test("rejects empty required variables", () => {
  const error = loadAndExpectError({
    POSTGRES_USER: "   ",
    POSTGRES_DB: "",
    POSTGRES_PASSWORD_FILE: "\t",
  });

  assert.match(error.message, /POSTGRES_USER must not be empty/);
  assert.match(error.message, /POSTGRES_DB must not be empty/);
  assert.match(error.message, /POSTGRES_PASSWORD_FILE must not be empty/);
});

test("rejects malformed ports", () => {
  const file = passwordFile("s3cret");

  for (const value of ["abc", "-1", "0", "1.5", "65536", "5432abc", "1e3"]) {
    assert.match(
      loadAndExpectError({ ...baseEnv(file), WORMHOLE_PORT: value }).message,
      /WORMHOLE_PORT must be an integer between 1 and 65535/,
      `WORMHOLE_PORT=${value}`,
    );

    assert.match(
      loadAndExpectError({ ...baseEnv(file), POSTGRES_PORT: value }).message,
      /POSTGRES_PORT must be an integer between 1 and 65535/,
      `POSTGRES_PORT=${value}`,
    );
  }
});

test("rejects malformed timeouts", () => {
  const file = passwordFile("s3cret");

  for (const value of ["abc", "-1", "0", "1.5", "2147483648"]) {
    assert.match(
      loadAndExpectError({ ...baseEnv(file), SHUTDOWN_TIMEOUT_MS: value })
        .message,
      /SHUTDOWN_TIMEOUT_MS must be an integer between 1 and 2147483647/,
      `SHUTDOWN_TIMEOUT_MS=${value}`,
    );

    assert.match(
      loadAndExpectError({ ...baseEnv(file), DB_CONNECT_TIMEOUT_MS: value })
        .message,
      /DB_CONNECT_TIMEOUT_MS must be an integer between 1 and 2147483647/,
      `DB_CONNECT_TIMEOUT_MS=${value}`,
    );

    assert.match(
      loadAndExpectError({
        ...baseEnv(file),
        DB_HEALTH_CHECK_INTERVAL_MS: value,
      }).message,
      /DB_HEALTH_CHECK_INTERVAL_MS must be an integer between 1 and 2147483647/,
      `DB_HEALTH_CHECK_INTERVAL_MS=${value}`,
    );
  }
});

test("rejects an invalid LOG_LEVEL", () => {
  const file = passwordFile("s3cret");

  const error = loadAndExpectError({ ...baseEnv(file), LOG_LEVEL: "verbose" });

  assert.match(error.message, /LOG_LEVEL must be one of debug, info, warn, error/);
  assert.match(error.message, /received "verbose"/);
});

test("reports an unreadable password file with its resolved path", () => {
  const missing = path.join(tempRoot, "missing", "postgres_password.txt");

  const error = loadAndExpectError(baseEnv(missing));

  assert.match(error.message, /POSTGRES_PASSWORD_FILE: cannot read/);
  assert.match(error.message, /ENOENT/);
  assert.match(error.message, new RegExp(missing.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("rejects an empty password file", () => {
  for (const contents of ["", "\n\n", "   \n"]) {
    assert.match(
      loadAndExpectError(baseEnv(passwordFile(contents))).message,
      /POSTGRES_PASSWORD_FILE: .* is empty/,
    );
  }
});

test("strips trailing newlines from the password but keeps other whitespace", () => {
  const config = loadConfig(baseEnv(passwordFile("  pass phrase  \r\n")));

  assert.equal(config.database.password, "  pass phrase  \r");
});

test("rejects the legacy POSTGRES_PASSWORD variable with a migration hint", () => {
  const error = loadAndExpectError({
    POSTGRES_USER: "postgres",
    POSTGRES_DB: "wormhole",
    POSTGRES_PASSWORD: "postgres",
  });

  assert.match(error.message, /POSTGRES_PASSWORD is not supported/);
  assert.match(error.message, /set POSTGRES_PASSWORD_FILE/);
});

test("rejects POSTGRES_PASSWORD and POSTGRES_PASSWORD_FILE together", () => {
  const file = passwordFile("s3cret");

  const error = loadAndExpectError({
    ...baseEnv(file),
    POSTGRES_PASSWORD: "s3cret",
  });

  assert.match(error.message, /both set/);
  assert.match(error.message, /use only POSTGRES_PASSWORD_FILE/);
});

test("rejects DATABASE_URL because the app uses discrete variables", () => {
  const file = passwordFile("s3cret");

  const error = loadAndExpectError({
    ...baseEnv(file),
    DATABASE_URL: "postgres://postgres:s3cret@localhost:5432/wormhole",
  });

  assert.match(error.message, /DATABASE_URL is not supported/);
  assert.match(error.message, /POSTGRES_PASSWORD_FILE/);
});

test("ignores an empty DATABASE_URL value", () => {
  const file = passwordFile("s3cret");

  const config = loadConfig({ ...baseEnv(file), DATABASE_URL: "" });

  assert.equal(config.database.database, "wormhole");
});

test("parses RUN_MIGRATIONS_ON_STARTUP strictly", () => {
  const file = passwordFile("s3cret");

  for (const [raw, expected] of [
    ["true", true],
    ["TRUE", true],
    ["false", false],
    ["FaLsE", false],
  ] as const) {
    const config = loadConfig({
      ...baseEnv(file),
      RUN_MIGRATIONS_ON_STARTUP: raw,
    });

    assert.equal(config.runMigrationsOnStartup, expected, raw);
  }

  for (const raw of ["yes", "1", "0", "on", "truthy"]) {
    assert.match(
      loadAndExpectError({
        ...baseEnv(file),
        RUN_MIGRATIONS_ON_STARTUP: raw,
      }).message,
      /RUN_MIGRATIONS_ON_STARTUP must be "true" or "false"/,
      raw,
    );
  }
});

test("loadDatabaseConfig ignores DATABASE_URL while the API still rejects it", () => {
  const file = passwordFile("s3cret");
  const env = {
    ...baseEnv(file),
    DATABASE_URL: "postgres://postgres:s3cret@localhost:5432/wormhole",
  };

  assert.match(
    loadAndExpectError(env).message,
    /DATABASE_URL is not supported/,
  );

  assert.deepEqual(loadDatabaseConfig(env), {
    host: "localhost",
    port: 5_432,
    user: "postgres",
    password: "s3cret",
    database: "wormhole",
    connectTimeoutMs: 5_000,
  });
});

test("loadLogLevel parses LOG_LEVEL and rejects invalid values", () => {
  assert.equal(loadLogLevel({}), "info");
  assert.equal(loadLogLevel({ LOG_LEVEL: "WARN" }), "warn");
  assert.throws(
    () => loadLogLevel({ LOG_LEVEL: "verbose" }),
    /LOG_LEVEL must be one of debug, info, warn, error/,
  );
});

test("the entrypoint exits with a clear error before connecting", () => {
  const env: NodeJS.ProcessEnv = { ...process.env };

  for (const name of [
    "POSTGRES_USER",
    "POSTGRES_DB",
    "POSTGRES_PASSWORD",
    "POSTGRES_PASSWORD_FILE",
    "DATABASE_URL",
    "HOST",
    "POSTGRES_PORT",
    "WORMHOLE_PORT",
    "SHUTDOWN_TIMEOUT_MS",
    "DB_CONNECT_TIMEOUT_MS",
    "DB_HEALTH_CHECK_INTERVAL_MS",
    "LOG_LEVEL",
    "RUN_MIGRATIONS_ON_STARTUP",
  ]) {
    delete env[name];
  }

  const result = spawnSync(process.execPath, [path.join(REPO_ROOT, "src/index.ts")], {
    cwd: REPO_ROOT,
    env,
    encoding: "utf8",
    timeout: 10_000,
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Invalid configuration:/);
  assert.match(result.stderr, /POSTGRES_USER is required/);
  assert.match(result.stderr, /POSTGRES_DB is required/);
  assert.match(result.stderr, /POSTGRES_PASSWORD_FILE is required/);
});
