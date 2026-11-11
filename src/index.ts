import express from "express";
import urlRoutes from "./routes/url.router.ts";
import healthRoutes from "./routes/health.router.ts";
import metricsRoutes from "./routes/metrics.router.ts";
import { ConfigError, loadConfig } from "./config.ts";
import { createPool, waitForDatabase } from "./db/db.ts";
import { errorHandler, routeNotFound } from "./middleware/errorHandler.ts";
import { httpObservability } from "./middleware/httpObservability.ts";
import { requestContext } from "./middleware/requestContext.ts";
import { captureRouteBase } from "./observability/http.ts";
import { configureLogger, getRootLogger } from "./observability/logger.ts";
import { startDatabaseMonitor } from "./services/databaseMonitor.ts";

const main = async (): Promise<void> => {
  const config = loadConfig();
  configureLogger({ level: config.logLevel, service: "wormhole" });

  const logger = getRootLogger();
  const app = express();

  app.disable("x-powered-by");
  app.use(requestContext());
  app.use(httpObservability());
  app.use(express.json());
  app.use(healthRoutes);
  app.use(metricsRoutes);
  app.use("/shorten", captureRouteBase, urlRoutes);
  app.use(routeNotFound);
  app.use(errorHandler);

  const pool = createPool(config.database);

  try {
    await waitForDatabase();
    logger.info("database connected");
  } catch (err) {
    logger.error("unable to reach the database at startup", { error: err });
    await pool.end().catch(() => {});
    process.exitCode = 1;
    return;
  }

  const databaseMonitor = startDatabaseMonitor({
    intervalMs: config.dbHealthCheckIntervalMs,
  });

  const server = app.listen(config.httpPort, () => {
    logger.info("HTTP server listening", { port: config.httpPort });
  });

  let shuttingDown = false;

  const shutdown = (signal: NodeJS.Signals) => {
    if (shuttingDown) {
      logger.warn(`${signal} received again; forcing exit`, { signal });
      process.exit(1);
    }

    shuttingDown = true;
    databaseMonitor.stop();
    logger.info(`${signal} received; draining connections`, { signal });

    const forceTimer = setTimeout(() => {
      logger.error("graceful shutdown timed out; forcing exit", {
        signal,
        timeoutMs: config.shutdownTimeoutMs,
      });
      server.closeAllConnections();
      process.exit(1);
    }, config.shutdownTimeoutMs);

    // Stop accepting new connections and wait for in-flight requests. The
    // pool is closed only after the server has drained so in-flight queries
    // are not cancelled by pool.end().
    server.close(async (err) => {
      if (err) {
        logger.error("error while closing HTTP server", { error: err });
      }

      try {
        await pool.end();
        logger.info("shutdown complete");
        process.exitCode = err ? 1 : 0;
      } catch (poolErr) {
        logger.error("error while closing database pool", { error: poolErr });
        process.exitCode = 1;
      } finally {
        clearTimeout(forceTimer);
      }
    });

    // Keep-alive sockets with no active request must not hold shutdown open.
    server.closeIdleConnections();
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
};

try {
  await main();
} catch (err) {
  if (err instanceof ConfigError) {
    getRootLogger().error(err.message, { reason: "invalid_configuration" });
  } else {
    getRootLogger().error("startup failed", { error: err });
  }

  process.exitCode = 1;
}
