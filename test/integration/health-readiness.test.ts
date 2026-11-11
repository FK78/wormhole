import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { migrationEnv, spawnMigration } from "../helpers/migrations.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const POSTGRES_IMAGE = "postgres:18.6";
const DB_NAME = "wormhole";
const DB_USER = "wormhole";
const DB_PASSWORD = "wormhole-test-secret";

// The app and PostgreSQL must read the password from the same file. The
// integration database is started with POSTGRES_PASSWORD, so write that same
// value to the file the app reads.
const PASSWORD_DIR = mkdtempSync(
  path.join(tmpdir(), "wormhole-health-integration-"),
);
const PASSWORD_FILE = path.join(PASSWORD_DIR, "postgres_password.txt");
writeFileSync(PASSWORD_FILE, DB_PASSWORD);

after(() => {
  rmSync(PASSWORD_DIR, { recursive: true, force: true });
});

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

  const valueSuffix =
    lastValue === undefined ? "" : `; last value: ${JSON.stringify(lastValue)}`;
  const errorSuffix =
    lastError instanceof Error ? `; last error: ${lastError.message}` : "";
  throw new Error(`Timed out after ${timeoutMs}ms${valueSuffix}${errorSuffix}`);
};

const waitForPostgres = async (
  containerName: string,
  timeoutMs = 60_000,
): Promise<void> => {
  await waitFor(
    async () => {
      execFileSync(
        "docker",
        ["exec", containerName, "pg_isready", "-U", DB_USER, "-d", DB_NAME],
        { stdio: "ignore", timeout: 5_000 },
      );
      return true;
    },
    (ready) => ready,
    timeoutMs,
    500,
  );
};

type HttpResponse = {
  status: number;
  headers: Headers;
  text: string;
  body: unknown;
};

const request = async (
  baseUrl: string,
  route: string,
): Promise<HttpResponse> => {
  const response = await fetch(`${baseUrl}${route}`);
  const text = await response.text();

  let body: unknown = undefined;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  return { status: response.status, headers: response.headers, text, body };
};

type AppProcess = {
  child: ChildProcess;
  baseUrl: string;
  logs: () => string;
};

const startApp = async (port: number, dbPort: number): Promise<AppProcess> => {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "test",
    HOST: "127.0.0.1",
    POSTGRES_USER: DB_USER,
    POSTGRES_PASSWORD_FILE: PASSWORD_FILE,
    POSTGRES_DB: DB_NAME,
    POSTGRES_PORT: String(dbPort),
    WORMHOLE_PORT: String(port),
  };
  delete env.POSTGRES_PASSWORD;
  delete env.DATABASE_URL;
  delete env.RUN_MIGRATIONS_ON_STARTUP;

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

      return request(app.baseUrl, "/healthz");
    },
    (response) => response.status === 200,
    30_000,
    250,
  ).catch((err: Error) => {
    throw new Error(`${err.message}\n${app.logs()}`);
  });

  return app;
};

const stopApp = (app: AppProcess): void => {
  if (app.child.exitCode === null && app.child.signalCode === null) {
    app.child.kill("SIGKILL");
  }
};

describe(
  "health and readiness endpoints",
  {
    skip: dockerAvailable ? false : "Docker is not available",
  },
  () => {
    const containerName = `wormhole-health-test-${process.pid}-${Date.now()}`;
    let app: AppProcess | undefined;
    let dbPort = 0;

    before(
      async () => {
        dbPort = await getFreePort();

        // A fixed host port is required because Docker can assign a new
        // ephemeral port when a container is stopped and started again.
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

        const migration = spawnMigration(
          ["up"],
          migrationEnv({
            dbPort,
            passwordFile: PASSWORD_FILE,
            database: DB_NAME,
            user: DB_USER,
          }),
        );
        assert.equal(
          migration.status,
          0,
          `Migration failed.\n${migration.stdout}\n${migration.stderr}`,
        );

        const appPort = await getFreePort();
        app = await startApp(appPort, dbPort);
      },
      { timeout: 180_000 },
    );

    after(async () => {
      if (app) stopApp(app);

      try {
        runDocker(["rm", "-f", containerName]);
      } catch {
        // Container may already be gone.
      }
    });

    test(
      "serves liveness and readiness while the database is up",
      { timeout: 30_000 },
      async () => {
        assert.ok(app, "app process was not started");

        const healthz = await request(app.baseUrl, "/healthz");
        assert.equal(healthz.status, 200);
        assert.equal(
          (healthz.body as { status: string }).status,
          "ok",
        );
        assert.equal(
          typeof (healthz.body as { version: unknown }).version,
          "string",
        );

        const readyz = await request(app.baseUrl, "/readyz");
        assert.equal(readyz.status, 200);
        assert.deepEqual((readyz.body as { checks: unknown }).checks, {
          database: "ok",
        });
      },
    );

    test(
      "reports 503 during an outage and recovers automatically",
      { timeout: 180_000 },
      async () => {
        assert.ok(app, "app process was not started");

        // Warm the pool so stopping PostgreSQL exercises pg-pool's
        // idle-client error path.
        await Promise.all([
          request(app.baseUrl, "/readyz"),
          request(app.baseUrl, "/readyz"),
          request(app.baseUrl, "/readyz"),
        ]);

        runDocker(["stop", "-t", "2", containerName], 30_000);

        const duringOutage = await waitFor(
          () => request(app.baseUrl, "/readyz"),
          (response) => response.status === 503,
          30_000,
          250,
        ).catch((err: Error) => {
          throw new Error(`${err.message}\n${app.logs()}`);
        });

        assert.deepEqual(
          (duringOutage.body as { checks: unknown }).checks,
          { database: "unavailable" },
        );
        assert.equal(duringOutage.headers.get("retry-after"), "1");

        for (const leak of [
          DB_PASSWORD,
          "ECONNREFUSED",
          "postgresql://",
          "127.0.0.1",
        ]) {
          assert.ok(
            !duringOutage.text.includes(leak),
            `/readyz response leaked "${leak}": ${duringOutage.text}`,
          );
        }

        const liveness = await request(app.baseUrl, "/healthz");
        assert.equal(liveness.status, 200);
        assert.equal(
          app.child.exitCode,
          null,
          `App exited during the outage.\n${app.logs()}`,
        );

        runDocker(["start", containerName], 30_000);
        await waitForPostgres(containerName);

        const recovered = await waitFor(
          () => request(app.baseUrl, "/readyz"),
          (response) => response.status === 200,
          60_000,
          500,
        ).catch((err: Error) => {
          throw new Error(`${err.message}\n${app.logs()}`);
        });

        assert.deepEqual((recovered.body as { checks: unknown }).checks, {
          database: "ok",
        });
        assert.equal(
          app.child.exitCode,
          null,
          `App exited after recovery.\n${app.logs()}`,
        );
      },
    );
  },
);
