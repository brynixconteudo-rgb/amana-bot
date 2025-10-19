// server.js
// 🌐 Núcleo do Amana_BOT — estável com healthcheck e logs

import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import chalk from "chalk";
import { authenticateGoogle, googleTest, runCommand } from "./apps/amana/google.js";
import telegramRouter from "./apps/amana/telegram.js";

const app = express();
app.set("trust proxy", true);
app.use(cors());
app.use(bodyParser.json({ limit: "10mb" }));

const BOT_KEY = process.env.AMANABOT_KEY || "amana_dev_key";
const PORT = Number(process.env.PORT) || 10000;
const HOST = "0.0.0.0";

// ✅ Healthcheck (Render verifica isso)
app.get("/healthz", (_req, res) => {
  res.status(200).json({
    status: "ok",
    service: "Amana_BOT",
    port: PORT,
    timestamp: new Date().toISOString(),
  });
});

// Evita 404 do favicon
app.get("/favicon.ico", (_req, res) => res.status(204).end());

// Página raiz
app.get("/", (_req, res) => {
  res.status(200).json({
    message: "🔥 Amana_BOT online e funcional!",
    endpoints: { health: "/healthz", test: "/amana/test", telegram: "/telegram/webhook", exec: "/amana/exec" },
  });
});

// Teste Google
app.get("/amana/test", async (_req, res) => {
  try {
    const auth = await authenticateGoogle();
    const result = await googleTest(auth);
    res.status(200).json({ status: "ok", result });
  } catch (err) {
    console.error(chalk.red("❌ Erro em /amana/test:"), err?.message);
    res.status(500).json({ status: "erro", message: err?.message });
  }
});

// Exec remota
app.post("/amana/exec", async (req, res) => {
  try {
    const { key, command, data } = req.body || {};
    if (key !== BOT_KEY) return res.status(403).json({ status: "erro", message: "Chave inválida" });
    const auth = await authenticateGoogle();
    const result = await runCommand(auth, command, data);
    res.status(200).json({ status: "ok", command, result });
  } catch (err) {
    console.error(chalk.red("❌ Erro em /amana/exec:"), err?.message);
    res.status(500).json({ status: "erro", message: err?.message });
  }
});

// Telegram
app.use("/telegram", telegramRouter);

// Start
app.listen(PORT, HOST, () => {
  console.log(chalk.cyanBright("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"));
  console.log(chalk.green(`🚀 Amana_BOT rodando em ${HOST}:${PORT}`));
  console.log(chalk.greenBright(`✅ Healthcheck: http://${HOST}:${PORT}/healthz`));
  console.log(chalk.magentaBright(`💬 Webhook Telegram: /telegram/webhook`));
  console.log(chalk.cyanBright("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"));
});
