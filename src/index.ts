import express from "express";
import urlRoutes from "./routes/url.router.ts"

const port = process.env.WORMHOLE_PORT || 3000;
const app = express();

app.use(express.json())

app.use("/shorten", urlRoutes)

app.listen(port, () => {
  console.log(`Wormhole API listening on port ${port}`);
});
