import { ConfigError, loadDatabaseConfig, loadLogLevel } from "../config.ts";
import { configureLogger, getRootLogger } from "../observability/logger.ts";
import {
  getStatus,
  runBaseline,
  runDown,
  runUp,
} from "./migrations.ts";

const COMMANDS = new Set(["up", "down", "status", "baseline"]);

class UsageError extends Error {}

const USAGE = `Usage: node dist/db/migrate.js <command> [options]

Commands:
  up                 Apply pending migrations
  down [count]       Roll back the most recent count migrations (default 1)
  status             Show applied and pending migrations
  baseline           Mark an existing public.urls schema as migration 0001

Connection settings come from HOST, POSTGRES_PORT, POSTGRES_USER, POSTGRES_DB,
and POSTGRES_PASSWORD_FILE. DATABASE_URL is ignored.
`;

const parseCount = (raw: string | undefined): number => {
  if (raw === undefined) return 1;

  const value = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;

  if (!Number.isSafeInteger(value) || value < 1) {
    throw new UsageError(
      `count must be a positive integer (received "${raw}")`,
    );
  }

  return value;
};

const main = async (): Promise<void> => {
  const command = process.argv[2];

  if (command === "--help" || command === "-h") {
    process.stdout.write(USAGE);
    return;
  }

  if (command === undefined || !COMMANDS.has(command)) {
    process.stderr.write(
      command === undefined
        ? USAGE
        : `Unknown command "${command}".\n\n${USAGE}`,
    );
    process.exitCode = 2;
    return;
  }

  const logger = configureLogger({
    service: "wormhole-migrate",
    level: loadLogLevel(),
  });
  const databaseUrl = process.env.DATABASE_URL;

  if (databaseUrl !== undefined && databaseUrl.trim() !== "") {
    logger.warn(
      "DATABASE_URL is set but ignored; migrations use the discrete POSTGRES_* variables and POSTGRES_PASSWORD_FILE",
    );
  }

  const database = loadDatabaseConfig();

  switch (command) {
    case "up": {
      const applied = await runUp(database);
      logger.info("migrations complete", { applied: applied.length });
      break;
    }

    case "down": {
      const reverted = await runDown(database, parseCount(process.argv[3]));
      logger.info("rollback complete", { reverted: reverted.length });
      break;
    }

    case "status": {
      logger.info("migration status", await getStatus(database));
      break;
    }

    case "baseline": {
      await runBaseline(database);
      break;
    }
  }
};

try {
  await main();
} catch (err) {
  if (err instanceof UsageError) {
    process.stderr.write(`${err.message}\n\n${USAGE}`);
    process.exitCode = 2;
  } else {
    if (err instanceof ConfigError) {
      getRootLogger().error(err.message, { reason: "invalid_configuration" });
    } else {
      getRootLogger().error("migration failed", { error: err });
    }

    process.exitCode = 1;
  }
}
