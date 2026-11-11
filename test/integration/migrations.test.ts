import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import {
  copyFileSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { Client } from "pg";
import type { DatabaseConfig } from "../../src/config.ts";
import { runDown, runUp } from "../../src/db/migrations.ts";
import { configureLogger } from "../../src/observability/logger.ts";
import {
  migrationEnv,
  spawnMigration,
} from "../helpers/migrations.ts";
import type { MigrationResult } from "../helpers/migrations.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const MIGRATIONS_DIR = path.join(REPO_ROOT, "db/migrations");
const FIXTURE_DIR = path.join(REPO_ROOT, "test/fixtures/migrations");
const POSTGRES_IMAGE = "postgres:18.6";
const DB_NAME = "wormhole";
const DB_USER = "postgres";
const DB_PASSWORD = "wormhole-migrations-secret";
const LEGACY_SCHEMA = `
CREATE TABLE urls (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    url TEXT NOT NULL,
    short_code TEXT UNIQUE NOT NULL,
    access_count INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ
);
`;

const PASSWORD_DIR = mkdtempSync(path.join(tmpdir(), "wormhole-migrations-"));
const PASSWORD_FILE = path.join(PASSWORD_DIR, "postgres_password.txt");
writeFileSync(PASSWORD_FILE, DB_PASSWORD);

// Keep in-process runUp/runDown logs out of the test output.
configureLogger({ service: "wormhole-migrations-test", level: "warn" });

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

const dockerAvailable = (() => {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore", timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
})();

const runDocker = (args: string[], timeout = 30_000): string =>
  execFileSync("docker", args, {
    encoding: "utf8",
    timeout,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

const waitFor = async <T>(
  operation: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs: number,
  intervalMs = 250,
): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  let lastValue: T | undefined;

  while (Date.now() < deadline) {
    try {
      const value = await operation();
      lastValue = value;
      if (predicate(value)) return value;
    } catch (err) {
      lastError = err;
    }

    await sleep(intervalMs);
  }

  const errorSuffix =
    lastError instanceof Error ? `; last error: ${lastError.message}` : "";
  throw new Error(
    `Timed out after ${timeoutMs}ms; last value: ${JSON.stringify(lastValue)}${errorSuffix}`,
  );
};

const waitForPostgres = async (
  containerName: string,
  timeoutMs = 60_000,
): Promise<void> => {
  await waitFor(
    async () => {
      execFileSync(
        "docker",
        [
          "exec",
          containerName,
          "pg_isready",
          "-U",
          DB_USER,
          "-d",
          DB_NAME,
        ],
        { stdio: "ignore", timeout: 5_000 },
      );
      return true;
    },
    (ready) => ready,
    timeoutMs,
    500,
  );
};

const getFreePort = async (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = net.createServer();

    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();

      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Unable to allocate a free TCP port"));
        return;
      }

      const { port } = address;
      server.close(() => resolve(port));
    });
  });

describe(
  "database migrations",
  {
    skip: dockerAvailable ? false : "Docker is not available",
  },
  () => {
    const containerName = `wormhole-migrations-${process.pid}-${Date.now()}`;
    let dbPort = 0;
    let app: AppProcess | undefined;

    const adminClient = async (): Promise<Client> => {
      const client = new Client({
        host: "127.0.0.1",
        port: dbPort,
        user: DB_USER,
        password: DB_PASSWORD,
        database: DB_NAME,
      });
      await client.connect();
      return client;
    };

    const resetPublicSchema = async (client: Client): Promise<void> => {
      await client.query("DROP SCHEMA IF EXISTS public CASCADE");
      await client.query("CREATE SCHEMA public");
    };

    const relationExists = async (
      client: Client,
      relation: string,
    ): Promise<boolean> => {
      const result = await client.query<{ relation: string | null }>(
        "SELECT to_regclass($1)::text AS relation",
        [relation],
      );
      return (
        result.rows[0]?.relation !== null &&
        result.rows[0]?.relation !== undefined
      );
    };

    const appliedNames = async (client: Client): Promise<string[]> => {
      if (!(await relationExists(client, "public.schema_migrations"))) {
        return [];
      }

      const result = await client.query<{ name: string }>(
        "SELECT name FROM public.schema_migrations ORDER BY run_on, name",
      );
      return result.rows.map((row) => row.name);
    };

    const urlsColumns = async (
      client: Client,
    ): Promise<
      {
        column_name: string;
        data_type: string;
        is_nullable: string;
        column_default: string | null;
      }[]
    > => {
      const result = await client.query<{
        column_name: string;
        data_type: string;
        is_nullable: string;
        column_default: string | null;
      }>(
        `SELECT column_name, data_type, is_nullable, column_default
           FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'urls'
          ORDER BY ordinal_position`,
      );
      return result.rows;
    };

    const createLegacySchema = async (client: Client): Promise<void> => {
      await client.query(LEGACY_SCHEMA);
      await client.query(
        `INSERT INTO urls (url, short_code, access_count)
         VALUES
           ('https://example.com/one', 'legacy1', 3),
           ('https://example.com/two', 'legacy2', 0)`,
      );
    };

    const migrationResult = (
      args: string[],
      overrides: NodeJS.ProcessEnv = {},
    ): MigrationResult =>
      spawnMigration(
        args,
        migrationEnv({
          dbPort,
          passwordFile: PASSWORD_FILE,
          database: DB_NAME,
          user: DB_USER,
          overrides,
        }),
      );

    const assertSuccess = (
      result: MigrationResult,
      label: string,
    ): void => {
      assert.equal(
        result.status,
        0,
        `${label} failed (status ${result.status}, signal ${result.signal}).\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      );
    };

    const assertFailure = (
      result: MigrationResult,
      label: string,
    ): void => {
      assert.notEqual(
        result.status,
        0,
        `${label} unexpectedly succeeded.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      );
    };

    const databaseConfig = (): DatabaseConfig => ({
      host: "127.0.0.1",
      port: dbPort,
      user: DB_USER,
      password: DB_PASSWORD,
      database: DB_NAME,
      connectTimeoutMs: 5_000,
    });

    before(
      async () => {
        dbPort = await getFreePort();

        runDocker([
          "run",
          "-d",
          "--name",
          containerName,
          "-e",
          `POSTGRES_USER=${DB_USER}`,
          "-e",
          `POSTGRES_PASSWORD=${DB_PASSWORD}`,
          "-e",
          `POSTGRES_DB=${DB_NAME}`,
          "-p",
          `127.0.0.1:${dbPort}:5432`,
          POSTGRES_IMAGE,
        ]);

        await waitForPostgres(containerName);
      },
      { timeout: 120_000 },
    );

    after(async () => {
      if (app) await stopApp(app);

      try {
        runDocker(["rm", "-f", containerName]);
      } catch {
        // Container may already be gone.
      }

      rmSync(PASSWORD_DIR, { recursive: true, force: true });
    });

    test(
      "fresh database: up creates the expected schema and is idempotent",
      { timeout: 120_000 },
      async () => {
        const admin = await adminClient();

        try {
          await resetPublicSchema(admin);

          assertSuccess(migrationResult(["up"]), "up");

          assert.ok(await relationExists(admin, "public.urls"));
          assert.ok(
            await relationExists(admin, "public.schema_migrations"),
          );

          const columns = await urlsColumns(admin);
          assert.deepEqual(
            columns.map((column) => ({
              name: column.column_name,
              type: column.data_type,
              nullable: column.is_nullable,
            })),
            [
              { name: "id", type: "uuid", nullable: "NO" },
              { name: "url", type: "text", nullable: "NO" },
              { name: "short_code", type: "text", nullable: "NO" },
              { name: "access_count", type: "integer", nullable: "NO" },
              {
                name: "created_at",
                type: "timestamp with time zone",
                nullable: "YES",
              },
              {
                name: "updated_at",
                type: "timestamp with time zone",
                nullable: "YES",
              },
            ],
          );

          const defaults = new Map(
            columns.map((column) => [
              column.column_name,
              column.column_default,
            ]),
          );
          assert.match(defaults.get("id") ?? "", /gen_random_uuid\(\)/);
          assert.equal(defaults.get("url"), null);
          assert.equal(defaults.get("short_code"), null);
          assert.equal(defaults.get("access_count"), "0");
          assert.match(defaults.get("created_at") ?? "", /now\(\)/);
          assert.equal(defaults.get("updated_at"), null);

          const constraints = await admin.query<{
            contype: string;
            attname: string;
          }>(
            `SELECT c.contype, a.attname
               FROM pg_constraint c
               JOIN pg_class t ON t.oid = c.conrelid
               JOIN pg_namespace n ON n.oid = t.relnamespace
               CROSS JOIN LATERAL unnest(c.conkey) AS key(attnum)
               JOIN pg_attribute a
                 ON a.attrelid = t.oid AND a.attnum = key.attnum
              WHERE n.nspname = 'public'
                AND t.relname = 'urls'
                AND c.contype IN ('p', 'u')`,
          );
          assert.ok(
            constraints.rows.some(
              (row) => row.contype === "p" && row.attname === "id",
            ),
          );
          assert.ok(
            constraints.rows.some(
              (row) => row.contype === "u" && row.attname === "short_code",
            ),
          );

          assert.deepEqual(await appliedNames(admin), ["0001_create_urls"]);

          await admin.query(
            `INSERT INTO urls (url, short_code) VALUES ('https://example.com/kept', 'kept1')`,
          );

          assertSuccess(migrationResult(["up"]), "second up");

          assert.deepEqual(await appliedNames(admin), ["0001_create_urls"]);
          const count = await admin.query<{ count: number }>(
            "SELECT count(*)::int AS count FROM urls",
          );
          assert.equal(count.rows[0]?.count, 1);
        } finally {
          await admin.end();
        }
      },
    );

    test(
      "rollback is tested for every migration and re-applies",
      { timeout: 120_000 },
      async () => {
        const admin = await adminClient();

        try {
          await resetPublicSchema(admin);
          assertSuccess(migrationResult(["up"]), "up");

          const expected = await appliedNames(admin);
          assert.ok(expected.length > 0, "expected at least one migration");

          for (let index = expected.length - 1; index >= 0; index -= 1) {
            assertSuccess(
              migrationResult(["down", "1"]),
              `down ${expected[index]}`,
            );

            assert.deepEqual(
              await appliedNames(admin),
              expected.slice(0, index),
            );
          }

          assert.equal(await relationExists(admin, "public.urls"), false);

          assertSuccess(migrationResult(["up"]), "re-up");
          assert.deepEqual(await appliedNames(admin), expected);
        } finally {
          await admin.end();
        }
      },
    );

    test(
      "existing volume: up auto-baselines and preserves data",
      { timeout: 120_000 },
      async () => {
        const admin = await adminClient();

        try {
          await resetPublicSchema(admin);
          await createLegacySchema(admin);

          assert.deepEqual(await appliedNames(admin), []);
          assert.equal(
            await relationExists(admin, "public.schema_migrations"),
            false,
          );

          const result = migrationResult(["up"]);
          assertSuccess(result, "up");
          assert.match(
            `${result.stdout}\n${result.stderr}`,
            /baselined existing schema at migration 0001_create_urls/,
          );

          assert.deepEqual(await appliedNames(admin), ["0001_create_urls"]);

          const rows = await admin.query<{
            short_code: string;
            access_count: number;
          }>(
            "SELECT short_code, access_count FROM urls ORDER BY short_code",
          );
          assert.deepEqual(rows.rows, [
            { short_code: "legacy1", access_count: 3 },
            { short_code: "legacy2", access_count: 0 },
          ]);

          assertSuccess(migrationResult(["up"]), "second up");
          assert.deepEqual(await appliedNames(admin), ["0001_create_urls"]);
        } finally {
          await admin.end();
        }
      },
    );

    test(
      "existing volume: a later migration applies and rolls back without data loss",
      { timeout: 120_000 },
      async () => {
        const admin = await adminClient();
        const combinedDir = mkdtempSync(
          path.join(tmpdir(), "wormhole-combined-migrations-"),
        );
        copyFileSync(
          path.join(MIGRATIONS_DIR, "0001_create_urls.sql"),
          path.join(combinedDir, "0001_create_urls.sql"),
        );
        copyFileSync(
          path.join(FIXTURE_DIR, "0002_add_test_marker.sql"),
          path.join(combinedDir, "0002_add_test_marker.sql"),
        );
        const dir = combinedDir;

        try {
          await resetPublicSchema(admin);
          await createLegacySchema(admin);

          await runUp(databaseConfig(), { dir });

          assert.deepEqual(await appliedNames(admin), [
            "0001_create_urls",
            "0002_add_test_marker",
          ]);
          assert.ok(
            (await urlsColumns(admin)).some(
              (column) => column.column_name === "test_marker",
            ),
          );

          const before = await admin.query<{ count: number }>(
            "SELECT count(*)::int AS count FROM urls",
          );
          assert.equal(before.rows[0]?.count, 2);

          await runDown(databaseConfig(), 1, { dir });

          assert.deepEqual(await appliedNames(admin), ["0001_create_urls"]);
          assert.equal(
            (await urlsColumns(admin)).some(
              (column) => column.column_name === "test_marker",
            ),
            false,
          );

          const afterRollback = await admin.query<{ count: number }>(
            "SELECT count(*)::int AS count FROM urls",
          );
          assert.equal(afterRollback.rows[0]?.count, 2);

          await runUp(databaseConfig(), { dir });

          assert.deepEqual(await appliedNames(admin), [
            "0001_create_urls",
            "0002_add_test_marker",
          ]);
        } finally {
          await admin.end();
          rmSync(combinedDir, { recursive: true, force: true });
        }
      },
    );

    test(
      "existing volume: a mismatched shape is refused without stamping",
      { timeout: 120_000 },
      async () => {
        const admin = await adminClient();

        try {
          await resetPublicSchema(admin);
          await admin.query(`
            CREATE TABLE urls (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                url TEXT NOT NULL,
                short_code TEXT NOT NULL,
                access_count INT NOT NULL DEFAULT 0,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                updated_at TIMESTAMPTZ
            )
          `);

          const result = migrationResult(["up"]);
          assertFailure(result, "up");

          const output = `${result.stdout}\n${result.stderr}`;
          assert.match(output, /does not match 0001_create_urls/);
          assert.match(output, /missing unique constraint/);
          assert.equal(
            await relationExists(admin, "public.schema_migrations"),
            false,
          );
        } finally {
          await admin.end();
        }
      },
    );

    test(
      "explicit baseline adopts a legacy schema and does not touch data",
      { timeout: 120_000 },
      async () => {
        const admin = await adminClient();

        try {
          await resetPublicSchema(admin);
          await createLegacySchema(admin);

          assertSuccess(migrationResult(["baseline"]), "baseline");
          assert.deepEqual(await appliedNames(admin), ["0001_create_urls"]);

          const rows = await admin.query<{ count: number }>(
            "SELECT count(*)::int AS count FROM urls",
          );
          assert.equal(rows.rows[0]?.count, 2);

          const second = migrationResult(["baseline"]);
          assertSuccess(second, "second baseline");
          assert.match(
            `${second.stdout}\n${second.stderr}`,
            /already applied; nothing to baseline/,
          );

          await resetPublicSchema(admin);
          assertFailure(migrationResult(["baseline"]), "baseline on fresh db");
        } finally {
          await admin.end();
        }
      },
    );

    test(
      "inconsistent history and missing tables fail loudly",
      { timeout: 120_000 },
      async () => {
        const admin = await adminClient();

        try {
          await resetPublicSchema(admin);
          assertSuccess(migrationResult(["up"]), "up");
          await admin.query("DROP TABLE urls");

          const missing = migrationResult(["up"]);
          assertFailure(missing, "up with missing table");
          assert.match(
            `${missing.stdout}\n${missing.stderr}`,
            /public\.urls is missing/,
          );

          await resetPublicSchema(admin);
          await admin.query(LEGACY_SCHEMA);
          await admin.query(`
            CREATE TABLE schema_migrations (
                id SERIAL PRIMARY KEY,
                name varchar(255) NOT NULL,
                run_on timestamp NOT NULL
            )
          `);
          await admin.query(
            "INSERT INTO schema_migrations (name, run_on) VALUES ('0002_fake', NOW())",
          );

          const inconsistent = migrationResult(["up"]);
          assertFailure(inconsistent, "up with inconsistent history");
          assert.match(
            `${inconsistent.stdout}\n${inconsistent.stderr}`,
            /history is inconsistent/,
          );
        } finally {
          await admin.end();
        }
      },
    );

    test(
      "status reports applied and pending migrations without creating history",
      { timeout: 120_000 },
      async () => {
        const admin = await adminClient();

        try {
          await resetPublicSchema(admin);

          const pending = migrationResult(["status"]);
          assertSuccess(pending, "status");
          assert.match(`${pending.stdout}\n${pending.stderr}`, /pending/);
          assert.match(
            `${pending.stdout}\n${pending.stderr}`,
            /0001_create_urls/,
          );
          assert.equal(
            await relationExists(admin, "public.schema_migrations"),
            false,
          );

          assertSuccess(migrationResult(["up"]), "up");

          const applied = migrationResult(["status"]);
          assertSuccess(applied, "status");
          assert.match(`${applied.stdout}\n${applied.stderr}`, /applied/);
          assert.match(
            `${applied.stdout}\n${applied.stderr}`,
            /0001_create_urls/,
          );
        } finally {
          await admin.end();
        }
      },
    );

    test(
      "up ignores DATABASE_URL and rejects usage errors",
      { timeout: 120_000 },
      async () => {
        const admin = await adminClient();

        try {
          await resetPublicSchema(admin);

          const result = migrationResult(["up"], {
            DATABASE_URL: "postgres://bad:bad@127.0.0.1:1/nope",
          });
          assertSuccess(result, "up with DATABASE_URL");
          assert.match(
            `${result.stdout}\n${result.stderr}`,
            /DATABASE_URL is set but ignored/,
          );
          assert.deepEqual(await appliedNames(admin), ["0001_create_urls"]);

          assert.equal(migrationResult(["down", "0"]).status, 2);
          assert.equal(migrationResult(["down", "-1"]).status, 2);
          assert.equal(migrationResult(["down", "1.5"]).status, 2);
          assert.equal(migrationResult(["frobnicate"]).status, 2);
          assert.equal(migrationResult(["--help"]).status, 0);
        } finally {
          await admin.end();
        }
      },
    );

    test(
      "guarded startup applies migrations before listening",
      { timeout: 120_000 },
      async () => {
        const admin = await adminClient();
        const appPort = await getFreePort();

        try {
          await resetPublicSchema(admin);

          app = await startApp(appPort, dbPort);

          const response = await fetch(`${app.baseUrl}/shorten`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              url: "https://example.com/guarded-startup",
            }),
          });
          assert.equal(
            response.status,
            201,
            `Unexpected response.\n${app.logs()}`,
          );

          assert.deepEqual(await appliedNames(admin), ["0001_create_urls"]);

          const rows = await admin.query<{ count: number }>(
            "SELECT count(*)::int AS count FROM urls",
          );
          assert.equal(rows.rows[0]?.count, 1);
        } finally {
          if (app) await stopApp(app);
          app = undefined;
          await admin.end();
        }
      },
    );
  },
);

type AppProcess = {
  child: ChildProcess;
  baseUrl: string;
  logs: () => string;
};

const startApp = async (
  port: number,
  dbPort: number,
): Promise<AppProcess> => {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "test",
    HOST: "127.0.0.1",
    POSTGRES_USER: DB_USER,
    POSTGRES_PASSWORD_FILE: PASSWORD_FILE,
    POSTGRES_DB: DB_NAME,
    POSTGRES_PORT: String(dbPort),
    WORMHOLE_PORT: String(port),
    RUN_MIGRATIONS_ON_STARTUP: "true",
  };
  delete env.POSTGRES_PASSWORD;
  delete env.DATABASE_URL;

  const child = spawn(process.execPath, [path.join(REPO_ROOT, "src/index.ts")], {
    cwd: REPO_ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";

  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  const app: AppProcess = {
    child,
    baseUrl: `http://127.0.0.1:${port}`,
    logs: () => `--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
  };

  await waitFor(
    async () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`App exited before becoming ready.\n${app.logs()}`);
      }

      return fetch(`${app.baseUrl}/healthz`)
        .then((response) => response.status)
        .catch(() => 0);
    },
    (status) => status === 200,
    30_000,
  );

  return app;
};

const stopApp = (app: AppProcess): Promise<void> =>
  new Promise((resolve) => {
    if (app.child.exitCode !== null || app.child.signalCode !== null) {
      resolve();
      return;
    }

    const timer = setTimeout(() => {
      app.child.kill("SIGKILL");
    }, 6_000);

    app.child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });

    app.child.kill("SIGTERM");
  });
