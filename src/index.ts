import express from "express";

const port = process.env.WORMHOLE_PORT || 3000;
const app = express();

app.listen(port, () => {
  console.log(`Wormhole API listening on port ${port}`);
});
