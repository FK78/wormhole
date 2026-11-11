import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const SCHEMA_PATH = path.join(REPO_ROOT, "db/schema.sql");
const ALERTS_PATH = path.join(REPO_ROOT, "observability/alerts.yml");
const POSTGRES_IMAGE = "postgres:18.6";
const PROMETHEUS_IMAGE = "prom/prometheus:v3.16.0";
const DB_NAME = "wormhole";
const DB_USER = "wormhole";
const DB_PASSWORD = "wormhole-observability-secret";

const PASSWORD_DIR = mkdtempSync(
  path.join(tmpdir(), "wormhole-observability-"),
);
const PASSWORD_FILE = path.join(PASSWORD_DIR, "postgres_password.txt");
writeFileSync(PASSWORD_FILE, DB_PASSWORD);

// Docker Desktop bind mounts are most reliable from a path inside the repo;
// the directory is removed in the after hook.
const PROMETHEUS_DIR = mkdtempSync(
  path.join(REPO_ROOT, ".observability-test-"),
);
chmodSync(PROMETHEUS_DIR, 0o755);
const PROMETHEUS_CONFIG = path.join(PROMETHEUS_DIR, "prometheus.yml");

after(() => {
  rmSync(PASSWORD_DIR, { recursive: true, force: true });
  rmSync(PROMETHEUS_DIR, { recursive: true, force: true });
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

const runDocker = (args: string[], timeout = 120_000): string =>
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
  init?: RequestInit,
): Promise<HttpResponse> => {
  const response = await fetch(`${baseUrl}${route}`, {
    ...init,
    signal: AbortSignal.timeout(10_000),
  });
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
  rawLogs: () => string;
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
    DB_CONNECT_TIMEOUT_MS: "2000",
    DB_HEALTH_CHECK_INTERVAL_MS: "500",
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
    rawLogs: () => `${stdout}${stderr}`,
  };

  await waitFor(
    async () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`App exited before becoming ready.\n${app.logs()}`);
      }

      return request(app.baseUrl, "/healthz");
    },
    (response) => response.status === 200,
    60_000,
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

const parseLogs = (logs: string): Array<Record<string, unknown>> =>
  logs
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        throw new Error(`Non-JSON log line: ${line}`);
      }
    });

const metricValue = (text: string, name: string, labels = ""): number | undefined => {
  const prefix = `${name}${labels} `;
  const line = text.split("\n").find((candidate) => candidate.startsWith(prefix));

  return line ? Number(line.slice(prefix.length)) : undefined;
};

const writePrometheusConfig = (appPort: number): void => {
  writeFileSync(
    PROMETHEUS_CONFIG,
    [
      "global:",
      "  scrape_interval: 1s",
      "  evaluation_interval: 1s",
      "rule_files:",
      '  - "/etc/prometheus/alerts.yml"',
      "scrape_configs:",
      "  - job_name: wormhole",
      "    metrics_path: /metrics",
      "    static_configs:",
      "      - targets:",
      `          - "host.docker.internal:${appPort}"`,
      "",
    ].join("\n"),
  );
};

const startPrometheus = async (
  containerName: string,
  port: number,
): Promise<string> => {
  runDocker([
    "run",
    "-d",
    "--name",
    containerName,
    "--add-host",
    "host.docker.internal:host-gateway",
    "-p",
    `127.0.0.1:${port}:9090`,
    "-v",
    `${PROMETHEUS_CONFIG}:/etc/prometheus/prometheus.yml:ro`,
    "-v",
    `${ALERTS_PATH}:/etc/prometheus/alerts.yml:ro`,
    PROMETHEUS_IMAGE,
    "--config.file=/etc/prometheus/prometheus.yml",
    "--storage.tsdb.path=/prometheus",
  ]);

  const baseUrl = `http://127.0.0.1:${port}`;

  await waitFor(
    async () => {
      const response = await fetch(`${baseUrl}/-/ready`, {
        signal: AbortSignal.timeout(2_000),
      });
      return response.ok;
    },
    (ready) => ready,
    30_000,
    250,
  );

  return baseUrl;
};

type PrometheusTarget = {
  health: string;
  scrapeUrl: string;
  lastError?: string;
};

type PrometheusTargetsResponse = {
  data: { activeTargets: PrometheusTarget[] };
};

const waitForScrapeTarget = async (prometheusUrl: string): Promise<void> => {
  await waitFor(
    async () => {
      const response = await fetch(`${prometheusUrl}/api/v1/targets`, {
        signal: AbortSignal.timeout(2_000),
      });
      return (await response.json()) as PrometheusTargetsResponse;
    },
    (body) => body.data.activeTargets.some((target) => target.health === "up"),
    30_000,
    500,
  );
};

type PrometheusRule = {
  name: string;
  state: string;
  alerts: Array<{ state: string; labels: Record<string, string> }>;
};

type PrometheusRulesResponse = {
  data: { groups: Array<{ rules: PrometheusRule[] }> };
};

const getAlertRule = async (
  prometheusUrl: string,
  name: string,
): Promise<PrometheusRule | undefined> => {
  const response = await fetch(`${prometheusUrl}/api/v1/rules?type=alert`, {
    signal: AbortSignal.timeout(2_000),
  });
  const body = (await response.json()) as PrometheusRulesResponse;

  return body.data.groups
    .flatMap((group) => group.rules)
    .find((rule) => rule.name === name);
};

describe(
  "observability",
  {
    skip: dockerAvailable ? false : "Docker is not available",
  },
  () => {
    const dbContainer = `wormhole-obs-db-${process.pid}-${Date.now()}`;
    const promContainer = `wormhole-obs-prom-${process.pid}-${Date.now()}`;
    let app: AppProcess | undefined;
    let prometheusUrl = "";
    let createdShortCode = "";

    before(
      async () => {
        const dbPort = await getFreePort();
        const appPort = await getFreePort();
        const promPort = await getFreePort();

        runDocker([
          "run",
          "-d",
          "--name",
          dbContainer,
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

        await waitForPostgres(dbContainer);

        app = await startApp(appPort, dbPort);

        writePrometheusConfig(appPort);
        prometheusUrl = await startPrometheus(promContainer, promPort);
        await waitForScrapeTarget(prometheusUrl);
      },
      { timeout: 240_000 },
    );

    after(async () => {
      if (app) stopApp(app);

      for (const container of [promContainer, dbContainer]) {
        try {
          runDocker(["rm", "-f", container], 30_000);
        } catch {
          // The container may already be gone.
        }
      }
    });

    test(
      "writes correlated JSON logs without credentials or query secrets",
      { timeout: 60_000 },
      async () => {
        assert.ok(app, "app process was not started");

        const secretUrl =
          "https://example.com/private?token=super-secret-token&password=hunter2";
        const createId = "obs-create-1";

        const created = await request(app.baseUrl, "/shorten", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-request-id": createId,
          },
          body: JSON.stringify({ url: secretUrl }),
        });

        assert.equal(created.status, 201);
        assert.equal(created.headers.get("x-request-id"), createId);

        createdShortCode = (created.body as { shortCode: string }).shortCode;
        assert.ok(createdShortCode);

        const readId = "obs-read-1";
        const retrieved = await request(
          app.baseUrl,
          `/shorten/${createdShortCode}`,
          { headers: { "x-request-id": readId } },
        );

        assert.equal(retrieved.status, 200);
        assert.equal(retrieved.headers.get("x-request-id"), readId);

        await waitFor(
          async () => {
            const logs = parseLogs(app.rawLogs());
            return (
              logs.some((entry) => entry.requestId === createId) &&
              logs.some((entry) => entry.requestId === readId)
            );
          },
          (ready) => ready,
          5_000,
          100,
        );

        const entries = parseLogs(app.rawLogs());

        for (const entry of entries) {
          assert.equal(typeof entry.timestamp, "string");
          assert.ok(
            !Number.isNaN(Date.parse(entry.timestamp as string)),
            `bad timestamp: ${entry.timestamp}`,
          );
          assert.equal(entry.service, "wormhole");
          assert.equal(typeof entry.level, "string");
          assert.equal(typeof entry.message, "string");
        }

        const createEntry = entries.find(
          (entry) =>
            entry.requestId === createId &&
            entry.message === "HTTP request completed",
        );
        const readEntry = entries.find(
          (entry) =>
            entry.requestId === readId &&
            entry.message === "HTTP request completed",
        );

        assert.ok(createEntry, app.logs());
        assert.equal(createEntry.method, "POST");
        assert.equal(createEntry.route, "/shorten");
        assert.equal(createEntry.status, 201);
        assert.equal(typeof createEntry.durationMs, "number");

        assert.ok(readEntry, app.logs());
        assert.equal(readEntry.method, "GET");
        assert.equal(readEntry.route, "/shorten/:id");
        assert.equal(readEntry.status, 200);

        const output = app.logs();
        for (const leak of [
          DB_PASSWORD,
          "super-secret-token",
          "hunter2",
          "postgresql://",
        ]) {
          assert.ok(!output.includes(leak), `logs leaked "${leak}"`);
        }
      },
    );

    test(
      "exposes RED metrics, database availability, and pool saturation",
      { timeout: 60_000 },
      async () => {
        assert.ok(app, "app process was not started");

        const missing = await request(app.baseUrl, "/shorten/does-not-exist");
        assert.equal(missing.status, 404);

        await waitFor(
          async () => {
            const response = await request(app.baseUrl, "/metrics");
            return (
              metricValue(
                response.text,
                "wormhole_http_requests_total",
                '{method="GET",route="/shorten/:id",status="404"}',
              ) ?? 0
            );
          },
          (value) => value >= 1,
          5_000,
          100,
        );

        await waitFor(
          async () => {
            const response = await request(app.baseUrl, "/metrics");
            return metricValue(response.text, "wormhole_database_up");
          },
          (value) => value === 1,
          15_000,
          250,
        );

        const metrics = await request(app.baseUrl, "/metrics");

        assert.equal(metrics.status, 200);
        assert.equal(
          metrics.headers.get("content-type"),
          "text/plain; version=0.0.4; charset=utf-8",
        );

        assert.ok(
          (metricValue(
            metrics.text,
            "wormhole_http_requests_total",
            '{method="POST",route="/shorten",status="201"}',
          ) ?? 0) >= 1,
          metrics.text,
        );
        assert.ok(
          (metricValue(
            metrics.text,
            "wormhole_http_requests_total",
            '{method="GET",route="/shorten/:id",status="404"}',
          ) ?? 0) >= 1,
          metrics.text,
        );
        assert.ok(
          (metricValue(
            metrics.text,
            "wormhole_http_request_duration_seconds_count",
            '{method="GET",route="/shorten/:id"}',
          ) ?? 0) >= 1,
          metrics.text,
        );

        assert.equal(
          metricValue(metrics.text, "wormhole_db_pool_waiting_clients"),
          0,
        );
        assert.ok(
          (metricValue(metrics.text, "wormhole_db_pool_max_connections") ?? 0) > 0,
        );
        assert.ok(
          (metricValue(metrics.text, "wormhole_db_pool_total_connections") ?? -1) >= 0,
        );

        assert.ok(
          metrics.text.includes(
            'wormhole_database_health_checks_total{status="up"}',
          ),
          metrics.text,
        );

        assert.ok(
          !metrics.text.includes('route="/healthz"'),
          "health probes leaked into RED metrics",
        );

        assert.ok(
          !metrics.text.includes(createdShortCode),
          "raw short code leaked into metrics",
        );
      },
    );

    test(
      "fires the database-unavailable alert and correlates 503 error logs when PostgreSQL is lost",
      { timeout: 240_000 },
      async () => {
        assert.ok(app, "app process was not started");

        await waitFor(
          async () => {
            const response = await request(app.baseUrl, "/metrics");
            return metricValue(response.text, "wormhole_database_up");
          },
          (value) => value === 1,
          15_000,
          250,
        );

        runDocker(["stop", "-t", "2", dbContainer], 30_000);

        await waitFor(
          async () => {
            const response = await request(app.baseUrl, "/metrics");
            return metricValue(response.text, "wormhole_database_up");
          },
          (value) => value === 0,
          30_000,
          250,
        );

        const requestId = "obs-db-down-1";
        const failed = await request(app.baseUrl, "/shorten", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-request-id": requestId,
          },
          body: JSON.stringify({ url: "https://example.com/during-outage" }),
        });

        assert.equal(failed.status, 503);
        assert.equal(failed.headers.get("retry-after"), "1");
        assert.equal(failed.headers.get("x-request-id"), requestId);

        const readiness = await request(app.baseUrl, "/readyz");
        assert.equal(readiness.status, 503);

        await waitFor(
          async () => {
            const entries = parseLogs(app.rawLogs());
            return entries.some(
              (entry) =>
                entry.requestId === requestId &&
                entry.message === "database unavailable while handling request",
            );
          },
          (ready) => ready,
          5_000,
          100,
        );

        const entries = parseLogs(app.rawLogs()).filter(
          (entry) => entry.requestId === requestId,
        );
        const errorEntry = entries.find(
          (entry) => entry.message === "database unavailable while handling request",
        );
        const accessEntry = entries.find(
          (entry) => entry.message === "HTTP request completed",
        );

        assert.ok(errorEntry, app.logs());
        assert.equal(errorEntry.level, "error");
        assert.equal(errorEntry.route, "/shorten");
        assert.equal(typeof errorEntry.errorCode, "string");
        assert.equal(
          typeof (errorEntry.error as Record<string, unknown>).stack,
          "string",
        );

        assert.ok(accessEntry, app.logs());
        assert.equal(accessEntry.level, "error");
        assert.equal(accessEntry.route, "/shorten");
        assert.equal(accessEntry.status, 503);

        const output = entries.map((entry) => JSON.stringify(entry)).join("\n");
        assert.ok(!output.includes(DB_PASSWORD), output);

        await waitFor(
          () => getAlertRule(prometheusUrl, "WormholeDatabaseUnavailable"),
          (rule) => rule?.state === "firing",
          120_000,
          1_000,
        );

        const rule = await getAlertRule(
          prometheusUrl,
          "WormholeDatabaseUnavailable",
        );

        assert.ok(rule, "alert rule is missing");
        assert.equal(rule.state, "firing");
        assert.ok(rule.alerts.length > 0);
        assert.equal(rule.alerts[0]?.labels.severity, "critical");
        assert.equal(rule.alerts[0]?.labels.service, "wormhole");
      },
    );
  },
);
