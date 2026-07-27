import express from "express";
import urlRoutes from "./routes/url.router.ts"
import { pool } from "./db/db.ts";

const port = process.env.WORMHOLE_PORT || 3000;
const app = express();

app.use(express.json())

try {
  await pool.query("SELECT 1");
  console.log("DB Connected");
} catch (err) {
  console.error(err);
  process.exit(1);
}

app.use("/shorten", urlRoutes)

app.listen(port, () => {
  console.log(`Wormhole API listening on port ${port}`);
});
