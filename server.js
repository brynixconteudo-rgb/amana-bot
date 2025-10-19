// server.js
// 🌐 Núcleo do Amana_BOT — versão estável e compatível com Render (corrige 502 no healthcheck)

import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import chalk from "chalk";
import { authenticateGoogle, googleTest, runCommand } from "./apps/amana/google.js";
import telegramRouter from "./apps/amana/telegram.js";

const app = express();
app.set("trust proxy", true); // 🔑 essencial para Render
app.use(cors());
app.use(bodyParser.json({ limit: "10mb" }));

// 🔐 Chave simples para execução remota
const BOT_KEY = process.env.AMANABOT_KEY || "amana_dev_key";
const PORT = Number(process.env.PORT) || 8080;
const HOST = "0.0.0.0"; // 🔑 obrigatório p/ Render expor externamente

// ✅ Healthcheck detalhado (usado internamente)
app.get("/healthz", (_req, res) => {
  res.status(200).json({
    status: "ok",
    service: "Amana_BOT",
    port: PORT,
    timestamp: new Date().toISOString(),
  });
});

// ✅ Healthcheck simples (usado pelo Render)
app.get("/", (_req, res) => {
  res.status(200).send("Amana_BOT OK");
});

// 🧩 Evita erro de favicon (Render/Browser)
app.get("/favicon.ico", (_req, res) => res.status(204).end());

// 🔍 Teste de conectividade com Google APIs
app.get("/amana/test", async (_req, res) => {
  try {
    const auth = await authenticateGoogle();
    const result = await googleTest(auth);
    res.status(200).json({ status: "ok", result });
  } catch (err) {
    console.error(chalk.red("❌ Erro em /amana/test:"), err.message);
    res.status(500).json({ status: "erro", message: err.message });
  }
});

// ⚙️ Execução de comandos remotos (SAVE_FILE, SEND_EMAIL, CREATE_EVENT, SAVE_MEMORY)
app.post("/amana/exec", async (req, res) => {
  try {
    const { key, command, data } = req.body || {};
    if (key !== BOT_KEY) {
      return res.status(403).json({ status: "erro", message: "Chave inválida" });
    }
    const auth = await authenticateGoogle();
    const result = await runCommand(auth, command, data);
    res.status(200).json({ status: "ok", command, result });
  } catch (err) {
    console.error(chalk.red("❌ Erro em /amana/exec:"), err.message);
    res.status(500).json({ status: "erro", message: err.message });
  }
});

// 📨 Webhook do Telegram
app.use("/telegram", telegramRouter);

// 🚀 Inicialização
app.listen(PORT, HOST, () => {
  console.log(chalk.cyanBright("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"));
  console.log(chalk.green(`🚀 Amana_BOT rodando em ${HOST}:${PORT}`));
  console.log(chalk.greenBright(`✅ Healthcheck interno: http://${HOST}:${PORT}/healthz`));
  console.log(chalk.greenBright(`✅ Healthcheck Render:  http://${HOST}:${PORT}/`));
  console.log(chalk.magentaBright(`💬 Webhook Telegram:   /telegram/webhook`));
  console.log(chalk.cyanBright("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"));
});
