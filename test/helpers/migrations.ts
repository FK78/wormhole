import { spawnSync } from "node:child_process";
import path from "node:path";

export const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

const MIGRATE_ENTRY = path.join(REPO_ROOT, "src/db/migrate.ts");

export type MigrationEnvOptions = {
  dbPort: number;
  passwordFile: string;
  database: string;
  user?: string;
  logLevel?: string;
  overrides?: NodeJS.ProcessEnv;
};

export const migrationEnv = (
  options: MigrationEnvOptions,
): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOST: "127.0.0.1",
    POSTGRES_PORT: String(options.dbPort),
    POSTGRES_USER: options.user ?? "postgres",
    POSTGRES_DB: options.database,
    POSTGRES_PASSWORD_FILE: options.passwordFile,
    LOG_LEVEL: options.logLevel ?? "info",
  };

  delete env.POSTGRES_PASSWORD;
  delete env.DATABASE_URL;
  delete env.RUN_MIGRATIONS_ON_STARTUP;

  return { ...env, ...options.overrides };
};

export type MigrationResult = {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

export const spawnMigration = (
  args: string[],
  env: NodeJS.ProcessEnv,
): MigrationResult => {
  const result = spawnSync(process.execPath, [MIGRATE_ENTRY, ...args], {
    cwd: REPO_ROOT,
    env,
    encoding: "utf8",
    timeout: 60_000,
  });

  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
};
