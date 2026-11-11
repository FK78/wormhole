import express from "express";
import urlRoutes from "./routes/url.router.ts";
import { ConfigError, loadConfig } from "./config.ts";
import { createPool, waitForDatabase } from "./db/db.ts";
import { errorHandler, routeNotFound } from "./middleware/errorHandler.ts";

const main = async (): Promise<void> => {
  const config = loadConfig();

  const app = express();

  app.use(express.json());
  app.use("/shorten", urlRoutes);
  app.use(routeNotFound);
  app.use(errorHandler);

  const pool = createPool(config.database);

  try {
    await waitForDatabase();
    console.log("DB Connected");
  } catch (err) {
    console.error("Unable to reach the database at startup", err);
    await pool.end().catch(() => {});
    process.exitCode = 1;
    return;
  }

  const server = app.listen(config.httpPort, () => {
    console.log(`Wormhole API listening on port ${config.httpPort}`);
  });

  let shuttingDown = false;

  const shutdown = (signal: NodeJS.Signals) => {
    if (shuttingDown) {
      console.warn(`${signal} received again; forcing exit`);
      process.exit(1);
    }

    shuttingDown = true;
    console.log(`${signal} received; draining connections...`);

    const forceTimer = setTimeout(() => {
      console.error(
        `Graceful shutdown exceeded ${config.shutdownTimeoutMs}ms; forcing exit`,
      );
      server.closeAllConnections();
      process.exit(1);
    }, config.shutdownTimeoutMs);

    // Stop accepting new connections and wait for in-flight requests. The
    // pool is closed only after the server has drained so in-flight queries
    // are not cancelled by pool.end().
    server.close(async (err) => {
      if (err) console.error("Error while closing HTTP server", err);

      try {
        await pool.end();
        console.log("Shutdown complete");
        process.exitCode = err ? 1 : 0;
      } catch (poolErr) {
        console.error("Error while closing database pool", poolErr);
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
    console.error(err.message);
    process.exitCode = 1;
  } else {
    throw err;
  }
}
