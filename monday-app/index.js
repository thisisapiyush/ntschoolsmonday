import express from "express";

const app = express();
const port = process.env.PORT || 8080;

app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.listen(port, () => {
  console.log(`Listening on port ${port}`);
});
