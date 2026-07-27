import express from "express";
import urlRoutes from "./routes/url.router.ts";
import { pool } from "./db/db.ts";
import { errorHandler, routeNotFound } from "./middleware/errorHandler.ts";

const port = process.env.WORMHOLE_PORT || 3000;
const app = express();

app.use(express.json());

const TIMEOUT_MS = 5_000;
try {
  await Promise.race([
    pool.query("SELECT 1"),
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error("DB health-check timed out")),
        TIMEOUT_MS,
      ),
    ),
  ]);
  console.log("DB Connected");
} catch (err) {
  console.error(err);
  process.exit(1);
}

app.use("/shorten", urlRoutes);

app.use(routeNotFound)
app.use(errorHandler);

app.listen(port, () => {
  console.log(`Wormhole API listening on port ${port}`);
});
