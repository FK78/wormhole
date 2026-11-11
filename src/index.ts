import express from "express";
import urlRoutes from "./routes/url.router.ts";
import healthRoutes from "./routes/health.router.ts";
import { pool, waitForDatabase } from "./db/db.ts";
import { errorHandler, routeNotFound } from "./middleware/errorHandler.ts";

const port = Number(process.env.WORMHOLE_PORT) || 3000;
const shutdownTimeoutMs = (() => {
    const value = Number(process.env.SHUTDOWN_TIMEOUT_MS);
    return Number.isFinite(value) && value > 0 ? value : 10_000;
})();
const app = express();

app.use(express.json());
app.use(healthRoutes);
app.use("/shorten", urlRoutes);
app.use(routeNotFound);
app.use(errorHandler);

try {
    await waitForDatabase();
    console.log("DB Connected");
} catch (err) {
    console.error("Unable to reach the database at startup", err);
    await pool.end().catch(() => {});
    process.exit(1);
}

const server = app.listen(port, () => {
    console.log(`Wormhole API listening on port ${port}`);
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
            `Graceful shutdown exceeded ${shutdownTimeoutMs}ms; forcing exit`,
        );
        server.closeAllConnections();
        process.exit(1);
    }, shutdownTimeoutMs);

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
