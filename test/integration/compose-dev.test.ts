import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { after, describe, test } from "node:test";
import { Client } from "pg";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const COMPOSE_FILE = path.join(REPO_ROOT, "compose.yml");
const DEV_COMPOSE_FILE = path.join(REPO_ROOT, "compose.dev.yml");
const DB_USER = "postgres";
const DB_NAME = "wormhole";
const DB_PASSWORD = "compose-dev-test";

const PROJECT = `wormhole-compose-dev-${process.pid}-${Date.now()}`;
const CONTAINER = `${PROJECT}-db`;
const TMP_DIR = mkdtempSync(path.join(REPO_ROOT, ".compose-dev-test-"));
const PASSWORD_FILE = path.join(TMP_DIR, "postgres_password.txt");
const OVERRIDE_FILE = path.join(TMP_DIR, "override.yml");

writeFileSync(PASSWORD_FILE, DB_PASSWORD);
// The base files hardcode `wormhole-db` and the global `wormhole_edge` name.
// Rename both so this disposable project never touches a developer's stack.
writeFileSync(
  OVERRIDE_FILE,
  [
    "services:",
    "  db:",
    `    container_name: ${CONTAINER}`,
    "  secret-init:",
    `    container_name: ${PROJECT}-secret-init`,
    "networks:",
    "  edge:",
    `    name: ${PROJECT}-unused-edge`,
    "",
  ].join("\n"),
);

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

const composeAvailable = (() => {
  if (!dockerAvailable) return false;

  try {
    execFileSync("docker", ["compose", "version"], {
      stdio: "ignore",
      timeout: 10_000,
    });
    return true;
  } catch {
    return false;
  }
})();

const skipReason = dockerAvailable
  ? composeAvailable
    ? false
    : "Docker Compose is not available"
  : "Docker is not available";

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

const composeArgs = (withDevOverlay: boolean, args: string[]): string[] => [
  "compose",
  "-p",
  PROJECT,
  "-f",
  COMPOSE_FILE,
  ...(withDevOverlay ? ["-f", DEV_COMPOSE_FILE] : []),
  "-f",
  OVERRIDE_FILE,
  ...args,
];

const runCompose = (
  withDevOverlay: boolean,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeout = 60_000,
): string =>
  execFileSync("docker", composeArgs(withDevOverlay, args), {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env,
    timeout,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

const composeEnv = (hostPort: number): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    POSTGRES_USER: DB_USER,
    POSTGRES_DB: DB_NAME,
    POSTGRES_PASSWORD_FILE: PASSWORD_FILE,
    POSTGRES_PORT: String(hostPort),
  };

  // These would silently change the compose invocation under test.
  delete env.COMPOSE_FILE;
  delete env.COMPOSE_PROJECT_NAME;
  delete env.COMPOSE_PROFILES;
  delete env.COMPOSE_PATH_SEPARATOR;
  delete env.POSTGRES_PASSWORD;
  delete env.DATABASE_URL;

  return env;
};

const waitForHealthy = async (): Promise<void> => {
  try {
    await waitFor(
      async () =>
        runDocker([
          "inspect",
          "--format",
          "{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}",
          CONTAINER,
        ]),
      (status) => status === "healthy",
      120_000,
      1_000,
    );
  } catch (err) {
    let logs = "";
    try {
      logs = runDocker(["logs", "--no-color", CONTAINER], 10_000);
    } catch {
      // The container may not exist yet; the timeout is the useful signal.
    }

    throw new Error(
      `${err instanceof Error ? err.message : String(err)}\n${logs}`,
    );
  }
};

const networkInternal = (name: string): string =>
  runDocker(["network", "inspect", "--format", "{{.Internal}}", name]);

const containerNetworks = (): Record<string, unknown> =>
  JSON.parse(
    runDocker([
      "inspect",
      "--format",
      "{{json .NetworkSettings.Networks}}",
      CONTAINER,
    ]),
  ) as Record<string, unknown>;

type PortBinding = { HostIp: string; HostPort: string };

const publishedPorts = (): Record<string, PortBinding[] | null | undefined> =>
  JSON.parse(
    runDocker([
      "inspect",
      "--format",
      "{{json .NetworkSettings.Ports}}",
      CONTAINER,
    ]),
  ) as Record<string, PortBinding[] | null | undefined>;

const selectOne = async (hostPort: number): Promise<number | undefined> => {
  const client = new Client({
    host: "127.0.0.1",
    port: hostPort,
    user: DB_USER,
    password: DB_PASSWORD,
    database: DB_NAME,
    connectionTimeoutMillis: 1_000,
    query_timeout: 2_000,
  });

  try {
    await client.connect();
    const result = await client.query("SELECT 1 AS ok");
    return result.rows[0]?.ok as number | undefined;
  } finally {
    await client.end().catch(() => undefined);
  }
};

let started = false;
let cleanupEnv: NodeJS.ProcessEnv | undefined;

after(async () => {
  try {
    if (started && cleanupEnv) {
      execFileSync(
        "docker",
        composeArgs(true, ["down", "-v", "--remove-orphans"]),
        {
          cwd: REPO_ROOT,
          env: cleanupEnv,
          stdio: "ignore",
          timeout: 120_000,
        },
      );
    }
  } catch {
    // Cleanup is best-effort; the project name is unique to this run.
  } finally {
    rmSync(TMP_DIR, { recursive: true, force: true });
  }
}, { timeout: 150_000 });

describe("compose dev overlay", { skip: skipReason }, () => {
  test(
    "publishes PostgreSQL on loopback without weakening backend isolation",
    { timeout: 300_000 },
    async () => {
      const hostPort = await getFreePort();
      const composeEnvironment = composeEnv(hostPort);
      cleanupEnv = composeEnvironment;

      // Phase 1: the base stack creates an internal-only backend and does not
      // publish the database port.
      started = true;
      runCompose(false, ["up", "-d", "db"], composeEnvironment, 180_000);
      await waitForHealthy();

      assert.equal(networkInternal(`${PROJECT}_backend`), "true");
      assert.throws(() => networkInternal(`${PROJECT}_dev`));
      const unpublished = publishedPorts()["5432/tcp"];
      assert.ok(
        !Array.isArray(unpublished) || unpublished.length === 0,
        `expected no published port, got ${JSON.stringify(unpublished)}`,
      );

      // Phase 2: the development overlay adds a port and a non-internal
      // network. Compose recreates the database container.
      runCompose(true, ["up", "-d", "db"], composeEnvironment, 180_000);
      await waitForHealthy();

      // Regression guard: publication must not come from weakening backend.
      assert.equal(networkInternal(`${PROJECT}_backend`), "true");
      assert.equal(networkInternal(`${PROJECT}_dev`), "false");

      const networks = Object.keys(containerNetworks());
      assert.ok(
        networks.includes(`${PROJECT}_backend`),
        `missing backend network: ${networks.join(", ")}`,
      );
      assert.ok(
        networks.includes(`${PROJECT}_dev`),
        `missing dev network: ${networks.join(", ")}`,
      );

      await waitFor(
        async () => selectOne(hostPort),
        (ok) => ok === 1,
        60_000,
        500,
      );

      const bindings = publishedPorts()["5432/tcp"];
      assert.ok(
        Array.isArray(bindings),
        `unexpected port bindings: ${JSON.stringify(bindings)}`,
      );
      assert.equal(bindings.length, 1);
      assert.equal(bindings[0]!.HostIp, "127.0.0.1");
      assert.equal(bindings[0]!.HostPort, String(hostPort));

      // The exact verification command documented in the README.
      assert.equal(
        runCompose(true, ["port", "db", "5432"], composeEnvironment),
        `127.0.0.1:${hostPort}`,
      );
    },
  );

  test(
    "secret-init succeeds when the secret volume already exists",
    { timeout: 120_000 },
    async () => {
      const secretEnv = composeEnv(5432);
      started = true;
      cleanupEnv = cleanupEnv ?? secretEnv;

      // The first run creates the volume; the second must not fail on the
      // existing UID 1000-owned file.
      runCompose(
        true,
        ["run", "--rm", "--no-deps", "secret-init"],
        secretEnv,
        60_000,
      );
      runCompose(
        true,
        ["run", "--rm", "--no-deps", "secret-init"],
        secretEnv,
        60_000,
      );
    },
  );
});
