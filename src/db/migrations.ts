import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { runner } from "node-pg-migrate";
import { Client } from "pg";
import type { ClientConfig } from "pg";
import type { DatabaseConfig } from "../config.ts";
import { getRootLogger } from "../observability/logger.ts";

export const BASELINE_MIGRATION = "0001_create_urls";

const MIGRATIONS_TABLE = "schema_migrations";
const MIGRATIONS_SCHEMA = "public";
// Resolves to <repo>/db/migrations from src and /app/db/migrations from dist.
const DEFAULT_MIGRATIONS_DIR = resolve(
  import.meta.dirname,
  "../../db/migrations",
);

export type MigrationOptions = {
  /**
   * Migration directory, resolved from the process working directory.
   * Defaults to the repository/image db/migrations directory. Tests use this
   * to point at a temporary directory with fixture migrations.
   */
  dir?: string;
};

export type MigrationStatus = {
  applied: string[];
  pending: string[];
  missing: string[];
};

type RunnerBaseOptions = {
  databaseUrl: ClientConfig;
  dir: string;
  schema: string;
  migrationsSchema: string;
  migrationsTable: string;
  singleTransaction: boolean;
  checkOrder: boolean;
  advisoryLockMode: "wait";
  verbose: boolean;
  log: (message: string) => void;
  logger: ReturnType<typeof getRootLogger>;
};

const EXPECTED_COLUMNS = [
  { name: "id", dataType: "uuid", nullable: false, hasDefault: true },
  { name: "url", dataType: "text", nullable: false, hasDefault: false },
  {
    name: "short_code",
    dataType: "text",
    nullable: false,
    hasDefault: false,
  },
  {
    name: "access_count",
    dataType: "integer",
    nullable: false,
    hasDefault: true,
  },
  {
    name: "created_at",
    dataType: "timestamp with time zone",
    nullable: true,
    hasDefault: true,
  },
  {
    name: "updated_at",
    dataType: "timestamp with time zone",
    nullable: true,
    hasDefault: false,
  },
] as const;

const clientConfig = (database: DatabaseConfig): ClientConfig => ({
  host: database.host,
  port: database.port,
  user: database.user,
  password: database.password,
  database: database.database,
  connectionTimeoutMillis: database.connectTimeoutMs,
  application_name: "wormhole-migrate",
});

const runnerOptions = (
  database: DatabaseConfig,
  dir: string,
): RunnerBaseOptions => ({
  databaseUrl: clientConfig(database),
  dir,
  schema: MIGRATIONS_SCHEMA,
  migrationsSchema: MIGRATIONS_SCHEMA,
  migrationsTable: MIGRATIONS_TABLE,
  singleTransaction: true,
  checkOrder: true,
  advisoryLockMode: "wait",
  verbose: false,
  log: (message) => getRootLogger().info(message),
  logger: getRootLogger(),
});

const resolveMigrationDir = (options: MigrationOptions = {}): string => {
  const dir = options.dir
    ? resolve(process.cwd(), options.dir)
    : DEFAULT_MIGRATIONS_DIR;

  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new Error(
      `Migrations directory not found: ${dir}. Check that db/migrations exists in the repository or the image.`,
    );
  }

  return dir;
};

const numericPrefix = (name: string): number => {
  const value = Number.parseInt(name, 10);

  if (!Number.isFinite(value)) {
    throw new Error(`Migration filename must start with a number: ${name}`);
  }

  return value;
};

export const listMigrationNames = (
  options: MigrationOptions = {},
): string[] => {
  const dir = resolveMigrationDir(options);
  const names = readdirSync(dir)
    .filter((entry) => entry.endsWith(".sql"))
    .map((entry) => basename(entry, ".sql"));

  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) {
      throw new Error(`Duplicate migration name: ${name}`);
    }
    seen.add(name);
  }

  names.sort((a, b) => {
    const difference = numericPrefix(a) - numericPrefix(b);
    return difference !== 0 ? difference : a.localeCompare(b);
  });

  return names;
};

const assertBaselineFirst = (names: string[]): void => {
  if (names[0] !== BASELINE_MIGRATION) {
    throw new Error(
      `Expected ${BASELINE_MIGRATION} to be the first migration, found ${names[0] ?? "no migrations"}.`,
    );
  }
};

const withClient = async <T>(
  database: DatabaseConfig,
  operation: (client: Client) => Promise<T>,
): Promise<T> => {
  const client = new Client(clientConfig(database));
  await client.connect();

  try {
    return await operation(client);
  } finally {
    await client.end().catch(() => {});
  }
};

type ExistingState = {
  urlsExists: boolean;
  appliedNames: string[];
};

const readExistingState = async (client: Client): Promise<ExistingState> => {
  const result = await client.query<{
    urls: string | null;
    history: string | null;
  }>(
    `SELECT to_regclass('${MIGRATIONS_SCHEMA}.urls')::text AS urls,
            to_regclass('${MIGRATIONS_SCHEMA}.${MIGRATIONS_TABLE}')::text AS history`,
  );
  const row = result.rows[0];
  const historyExists =
    row?.history !== null && row?.history !== undefined;

  let appliedNames: string[] = [];
  if (historyExists) {
    try {
      const history = await client.query<{ name: string }>(
        `SELECT name FROM ${MIGRATIONS_SCHEMA}.${MIGRATIONS_TABLE} ORDER BY run_on, name`,
      );
      appliedNames = history.rows.map((entry) => entry.name);
    } catch (err) {
      const code = (err as { code?: string }).code;

      if (code === "42703" || code === "42P01") {
        throw new Error(
          `public.${MIGRATIONS_TABLE} exists but is not a compatible node-pg-migrate history table (expected name and run_on columns). Inspect or rename it before running migrations.`,
        );
      }

      throw err;
    }
  }

  return {
    urlsExists: row?.urls !== null && row?.urls !== undefined,
    appliedNames,
  };
};

type ColumnRow = {
  column_name: string;
  data_type: string;
  is_nullable: string;
  column_default: string | null;
};

type ConstraintRow = {
  contype: string;
  columns: string[];
};

const checkUrlsShape = async (client: Client): Promise<void> => {
  const relation = await client.query<{ relkind: string }>(
    `SELECT c.relkind
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = '${MIGRATIONS_SCHEMA}' AND c.relname = 'urls'`,
  );
  const problems: string[] = [];

  if (relation.rows[0]?.relkind !== "r") {
    problems.push(
      `public.urls is not an ordinary table (relkind ${relation.rows[0]?.relkind ?? "missing"})`,
    );
  }

  const columns = await client.query<ColumnRow>(
    `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema = '${MIGRATIONS_SCHEMA}' AND table_name = 'urls'
      ORDER BY ordinal_position`,
  );
  const actualColumns = new Map(
    columns.rows.map((row) => [row.column_name, row]),
  );

  for (const expected of EXPECTED_COLUMNS) {
    const column = actualColumns.get(expected.name);

    if (!column) {
      problems.push(`missing column "${expected.name}"`);
      continue;
    }

    if (column.data_type !== expected.dataType) {
      problems.push(
        `column "${expected.name}" has type ${column.data_type}, expected ${expected.dataType}`,
      );
    }

    const isNullable = column.is_nullable === "YES";
    if (isNullable !== expected.nullable) {
      problems.push(
        `column "${expected.name}" is ${isNullable ? "nullable" : "NOT NULL"}, expected ${expected.nullable ? "nullable" : "NOT NULL"}`,
      );
    }

    if (expected.hasDefault && column.column_default === null) {
      problems.push(`column "${expected.name}" has no default`);
    }
  }

  for (const name of actualColumns.keys()) {
    if (!EXPECTED_COLUMNS.some((expected) => expected.name === name)) {
      problems.push(`unexpected column "${name}"`);
    }
  }

  const constraints = await client.query<ConstraintRow>(
    `SELECT c.contype, array_agg(a.attname::text ORDER BY a.attnum) AS columns
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       JOIN unnest(c.conkey) AS key(attnum) ON true
       JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = key.attnum
      WHERE n.nspname = '${MIGRATIONS_SCHEMA}'
        AND t.relname = 'urls'
        AND c.contype IN ('p', 'u')
      GROUP BY c.oid, c.contype`,
  );

  const hasPrimaryKey = constraints.rows.some(
    (constraint) =>
      constraint.contype === "p" &&
      constraint.columns.length === 1 &&
      constraint.columns[0] === "id",
  );
  const hasUniqueShortCode = constraints.rows.some(
    (constraint) =>
      constraint.contype === "u" &&
      constraint.columns.length === 1 &&
      constraint.columns[0] === "short_code",
  );

  if (!hasPrimaryKey) problems.push('missing primary key on "id"');
  if (!hasUniqueShortCode) {
    problems.push('missing unique constraint on "short_code"');
  }

  if (problems.length > 0) {
    throw new Error(
      `Existing public.urls does not match ${BASELINE_MIGRATION}: ${problems.join("; ")}. Nothing was stamped; reconcile the schema or restore from backup before retrying.`,
    );
  }
};

type BaselineDecision = {
  shouldBaseline: boolean;
  appliedNames: string[];
};

const inspectBaseline = async (
  database: DatabaseConfig,
  mode: "auto" | "explicit",
): Promise<BaselineDecision> =>
  withClient(database, async (client) => {
    const state = await readExistingState(client);

    if (state.appliedNames.length > 0) {
      if (state.appliedNames.includes(BASELINE_MIGRATION)) {
        return { shouldBaseline: false, appliedNames: state.appliedNames };
      }

      throw new Error(
        `Migration history is inconsistent: ${state.appliedNames.join(", ")} recorded without ${BASELINE_MIGRATION}. Refusing to modify the database.`,
      );
    }

    if (!state.urlsExists) {
      if (mode === "explicit") {
        throw new Error(
          'No existing public.urls table to baseline. Run "up" to create a fresh schema.',
        );
      }

      return { shouldBaseline: false, appliedNames: [] };
    }

    await checkUrlsShape(client);
    return { shouldBaseline: true, appliedNames: [] };
  });

const assertAppliedMigrationsExist = (
  appliedNames: string[],
  availableNames: string[],
): void => {
  const available = new Set(availableNames);
  const missing = appliedNames.filter((name) => !available.has(name));

  if (missing.length > 0) {
    throw new Error(
      `Migration history references migrations that are no longer present: ${missing.join(", ")}. Restore the files before running migrations.`,
    );
  }
};

const fakeBaseline = async (
  database: DatabaseConfig,
  dir: string,
): Promise<void> => {
  await runner({
    ...runnerOptions(database, dir),
    direction: "up",
    file: BASELINE_MIGRATION,
    fake: true,
  });

  getRootLogger().info(
    `baselined existing schema at migration ${BASELINE_MIGRATION}`,
  );
};

const verifyUrlsExists = async (database: DatabaseConfig): Promise<void> => {
  await withClient(database, async (client) => {
    const result = await client.query<{ urls: string | null }>(
      `SELECT to_regclass('${MIGRATIONS_SCHEMA}.urls')::text AS urls`,
    );

    if (result.rows[0]?.urls === null || result.rows[0]?.urls === undefined) {
      throw new Error(
        "Migration history is applied but public.urls is missing. The database schema is inconsistent; restore it from backup or reconcile it manually.",
      );
    }
  });
};

export const runUp = async (
  database: DatabaseConfig,
  options: MigrationOptions = {},
): Promise<string[]> => {
  const dir = resolveMigrationDir(options);
  const names = listMigrationNames({ dir });
  assertBaselineFirst(names);

  const decision = await inspectBaseline(database, "auto");
  assertAppliedMigrationsExist(decision.appliedNames, names);

  if (decision.shouldBaseline) {
    await fakeBaseline(database, dir);
  }

  const applied = await runner({
    ...runnerOptions(database, dir),
    direction: "up",
  });
  const appliedNames = applied.map((migration) => migration.name);

  for (const name of appliedNames) {
    getRootLogger().info(`applied migration ${name}`);
  }

  if (appliedNames.length === 0) {
    getRootLogger().info("no pending migrations");
  }

  await verifyUrlsExists(database);

  return appliedNames;
};

export const runBaseline = async (
  database: DatabaseConfig,
  options: MigrationOptions = {},
): Promise<void> => {
  const dir = resolveMigrationDir(options);
  const names = listMigrationNames({ dir });
  assertBaselineFirst(names);

  const decision = await inspectBaseline(database, "explicit");
  assertAppliedMigrationsExist(decision.appliedNames, names);

  if (!decision.shouldBaseline) {
    getRootLogger().info(
      `migration ${BASELINE_MIGRATION} is already applied; nothing to baseline`,
    );
    return;
  }

  await fakeBaseline(database, dir);
};

export const runDown = async (
  database: DatabaseConfig,
  count = 1,
  options: MigrationOptions = {},
): Promise<string[]> => {
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new Error("down count must be a positive integer");
  }

  const dir = resolveMigrationDir(options);

  getRootLogger().warn(
    "rolling back migrations; rolling back the baseline migration drops the urls table and all rows",
  );

  const reverted = await runner({
    ...runnerOptions(database, dir),
    direction: "down",
    count,
  });
  const revertedNames = reverted.map((migration) => migration.name);

  for (const name of revertedNames) {
    getRootLogger().info(`rolled back migration ${name}`);
  }

  if (revertedNames.length === 0) {
    getRootLogger().info("no applied migrations to roll back");
  }

  return revertedNames;
};

export const getStatus = async (
  database: DatabaseConfig,
  options: MigrationOptions = {},
): Promise<MigrationStatus> => {
  const dir = resolveMigrationDir(options);
  const names = listMigrationNames({ dir });
  const state = await withClient(database, readExistingState);
  const appliedSet = new Set(state.appliedNames);
  const availableSet = new Set(names);

  return {
    applied: [...state.appliedNames],
    pending: names.filter((name) => !appliedSet.has(name)),
    missing: state.appliedNames.filter((name) => !availableSet.has(name)),
  };
};
