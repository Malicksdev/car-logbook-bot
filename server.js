require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");

const webhookRouter = require("./routes/webhook");
const cronRouter    = require("./routes/cron");

const app = express();

app.use(express.json());
app.use(bodyParser.urlencoded({ extended: false }));

// ─── ROUTES ───────────────────────────────────────────────────────────────────

app.use("/whatsapp", webhookRouter);
app.use("/cron",     cronRouter);

// ─── START SERVER ─────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Bot running on port ${PORT}`);
});