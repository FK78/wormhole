import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { Client } from "pg";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const SCHEMA_PATH = path.join(REPO_ROOT, "db/schema.sql");
const POSTGRES_IMAGE = "postgres:18.6";
const DB_NAME = "wormhole";
const DB_USER = "postgres";
const DB_PASSWORD = "test";

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

  const valueSuffix =
    lastValue === undefined
      ? ""
      : `; last value: ${JSON.stringify(lastValue)}`;
  const errorSuffix =
    lastError instanceof Error ? `; last error: ${lastError.message}` : "";
  throw new Error(
    `Timed out after ${timeoutMs}ms${valueSuffix}${errorSuffix}`,
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

const ensurePostgres = async (containerName: string): Promise<void> => {
  runDocker(["start", containerName]);
  await waitForPostgres(containerName);
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

type HttpResponse = {
  status: number;
  headers: Headers;
  body: unknown;
};

type AppProcess = {
  child: ChildProcess;
  baseUrl: string;
  logs: () => string;
};

const request = async (
  baseUrl: string,
  route: string,
  init?: RequestInit,
): Promise<HttpResponse> => {
  const response = await fetch(`${baseUrl}${route}`, init);
  const text = await response.text();

  let body: unknown = undefined;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  return { status: response.status, headers: response.headers, body };
};

const waitForAppReady = async (app: AppProcess): Promise<void> => {
  await waitFor(
    async () => {
      if (app.child.exitCode !== null || app.child.signalCode !== null) {
        throw new Error(`App exited before becoming ready.\n${app.logs()}`);
      }

      return request(app.baseUrl, "/shorten", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url: `https://example.com/ready-${Date.now()}`,
        }),
      });
    },
    (response) => response.status === 201,
    30_000,
    250,
  );
};

const startApp = async (
  port: number,
  dbPort: number,
  shutdownTimeoutMs = 5_000,
  waitUntilReady = true,
): Promise<AppProcess> => {
  const child = spawn(process.execPath, [path.join(REPO_ROOT, "src/index.ts")], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      NODE_ENV: "test",
      HOST: "127.0.0.1",
      POSTGRES_USER: DB_USER,
      POSTGRES_PASSWORD: DB_PASSWORD,
      POSTGRES_DB: DB_NAME,
      POSTGRES_PORT: String(dbPort),
      WORMHOLE_PORT: String(port),
      SHUTDOWN_TIMEOUT_MS: String(shutdownTimeoutMs),
      DB_CONNECT_TIMEOUT_MS: "2000",
    },
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

  if (waitUntilReady) {
    await waitForAppReady(app);
  }

  return app;
};

const waitForExit = (
  child: ChildProcess,
  timeoutMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> => {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({
      code: child.exitCode,
      signal: child.signalCode,
    });
  }

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      child.off("exit", onExit);
    };

    const onExit = (
      code: number | null,
      signal: NodeJS.Signals | null,
    ) => {
      cleanup();
      resolve({ code, signal });
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`App did not exit within ${timeoutMs}ms`));
    }, timeoutMs);

    child.once("exit", onExit);
  });
};

const stopApp = async (app: AppProcess): Promise<void> => {
  if (app.child.exitCode !== null || app.child.signalCode !== null) return;

  app.child.kill("SIGTERM");

  try {
    await waitForExit(app.child, 6_000);
  } catch {
    app.child.kill("SIGKILL");
  }
};

describe(
  "database lifecycle",
  {
    skip: dockerAvailable ? false : "Docker is not available",
  },
  () => {
    const containerName = `wormhole-test-${process.pid}-${Date.now()}`;
    const apps: AppProcess[] = [];
    let dbPort = 0;

    before(
      async () => {
        // A fixed host port is required because Docker can assign a new
        // ephemeral port when a container is stopped and started again.
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
          "-v",
          `${SCHEMA_PATH}:/docker-entrypoint-initdb.d/schema.sql:ro`,
          POSTGRES_IMAGE,
        ]);

        const portOutput = runDocker([
          "port",
          containerName,
          "5432/tcp",
        ]);
        assert.equal(
          portOutput.split("\n")[0],
          `127.0.0.1:${dbPort}`,
          `Unexpected Postgres port mapping: ${portOutput}`,
        );

        await waitForPostgres(containerName);
      },
      { timeout: 120_000 },
    );

    after(async () => {
      for (const app of apps) {
        if (app.child.exitCode === null && app.child.signalCode === null) {
          app.child.kill("SIGKILL");
        }
      }

      try {
        runDocker(["rm", "-f", containerName]);
      } catch {
        // Container may already be gone.
      }
    });

    test(
      "survives a PostgreSQL restart and serves requests after recovery",
      { timeout: 120_000 },
      async () => {
        await ensurePostgres(containerName);

        const port = await getFreePort();
        const app = await startApp(port, dbPort);
        apps.push(app);

        try {
          const created = await request(app.baseUrl, "/shorten", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ url: "https://example.com/before-restart" }),
          });

          assert.equal(created.status, 201);
          const shortCode = (created.body as { shortCode: string }).shortCode;
          assert.ok(shortCode);

          const beforeRestart = await request(
            app.baseUrl,
            `/shorten/${shortCode}`,
          );
          assert.equal(beforeRestart.status, 200);

          // Fill the pool with a few idle clients so the restart exercises
          // pg-pool's idle-client error path.
          await Promise.all(
            Array.from({ length: 3 }, (_, index) =>
              request(app.baseUrl, "/shorten", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  url: `https://example.com/pool-${index}-${Date.now()}`,
                }),
              }),
            ),
          );

          runDocker(["stop", "-t", "10", containerName], 30_000);
          await sleep(500);

          assert.equal(
            app.child.exitCode,
            null,
            `App exited after PostgreSQL stopped.\n${app.logs()}`,
          );
          assert.equal(app.child.signalCode, null);

          const duringOutage = await request(app.baseUrl, "/shorten", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ url: "https://example.com/during-outage" }),
          });
          assert.equal(duringOutage.status, 503);
          assert.equal(
            app.child.exitCode,
            null,
            `App exited while PostgreSQL was unavailable.\n${app.logs()}`,
          );

          runDocker(["start", containerName], 30_000);
          await waitForPostgres(containerName);

          const recovered = await waitFor(
            () => request(app.baseUrl, `/shorten/${shortCode}`),
            (response) => response.status === 200,
            30_000,
            500,
          ).catch((err: Error) => {
            throw new Error(`${err.message}\n${app.logs()}`);
          });

          assert.equal(
            (recovered.body as { shortCode: string }).shortCode,
            shortCode,
          );
          assert.equal(
            app.child.exitCode,
            null,
            `App exited after PostgreSQL recovered.\n${app.logs()}`,
          );
        } finally {
          await stopApp(app);
        }
      },
    );

    test(
      "retries database startup with backoff while PostgreSQL is unavailable",
      { timeout: 60_000 },
      async () => {
        const port = await getFreePort();

        runDocker(["stop", "-t", "10", containerName], 30_000);

        let app: AppProcess | undefined;

        try {
          app = await startApp(port, dbPort, 5_000, false);
          apps.push(app);

          await sleep(1_000);

          assert.equal(
            app.child.exitCode,
            null,
            `App exited while waiting for PostgreSQL.\n${app.logs()}`,
          );
          assert.match(app.logs(), /\[db\] not ready/);

          runDocker(["start", containerName], 30_000);
          await waitForPostgres(containerName);
          await waitForAppReady(app);
        } finally {
          if (app) await stopApp(app);

          // Keep the database available for the remaining tests even if an
          // assertion above failed.
          try {
            await ensurePostgres(containerName);
          } catch {
            // The suite will report the original failure.
          }
        }
      },
    );

    test(
      "drains in-flight requests on SIGTERM and exits within the timeout",
      { timeout: 60_000 },
      async () => {
        await ensurePostgres(containerName);

        const port = await getFreePort();
        const app = await startApp(port, dbPort, 5_000);
        apps.push(app);

        const admin = new Client({
          host: "127.0.0.1",
          port: dbPort,
          user: DB_USER,
          password: DB_PASSWORD,
          database: DB_NAME,
        });
        await admin.connect();

        try {
          const created = await request(app.baseUrl, "/shorten", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ url: "https://example.com/drain-start" }),
          });

          assert.equal(created.status, 201);
          const shortCode = (created.body as { shortCode: string }).shortCode;

          await admin.query("BEGIN");
          await admin.query(
            "SELECT id FROM urls WHERE short_code = $1 FOR UPDATE",
            [shortCode],
          );

          // This request blocks on the row lock until we commit, which keeps
          // it in flight while the app receives SIGTERM.
          const updateRequest = request(app.baseUrl, `/shorten/${shortCode}`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ url: "https://example.com/drain-done" }),
          });

          await waitFor(
            async () => {
              const result = await admin.query(
                `SELECT count(*)::int AS count
                   FROM pg_stat_activity
                  WHERE datname = $1
                    AND wait_event_type = 'Lock'`,
                [DB_NAME],
              );
              return result.rows[0].count as number;
            },
            (count) => count > 0,
            5_000,
          );

          const startedAt = Date.now();
          app.child.kill("SIGTERM");
          await sleep(300);

          assert.equal(
            app.child.exitCode,
            null,
            `App exited before the in-flight request finished.\n${app.logs()}`,
          );

          await admin.query("COMMIT");

          const updated = await updateRequest;
          assert.equal(updated.status, 200);

          const exit = await waitForExit(app.child, 5_000);
          assert.equal(exit.code, 0);
          assert.ok(
            Date.now() - startedAt < 5_000,
            "App did not shut down within SHUTDOWN_TIMEOUT_MS",
          );
        } finally {
          await admin.query("ROLLBACK").catch(() => {});
          await admin.end().catch(() => {});
          await stopApp(app);
        }
      },
    );

    test(
      "handles SIGINT as a graceful shutdown",
      { timeout: 30_000 },
      async () => {
        await ensurePostgres(containerName);

        const port = await getFreePort();
        const app = await startApp(port, dbPort);
        apps.push(app);

        try {
          app.child.kill("SIGINT");
          const exit = await waitForExit(app.child, 5_000);
          assert.equal(exit.code, 0);
        } finally {
          await stopApp(app);
        }
      },
    );
  },
);
