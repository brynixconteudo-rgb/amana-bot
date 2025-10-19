import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import { authenticateGoogle, googleTest, runCommand } from "./apps/amana/google.js";
import telegramRouter from "./apps/amana/telegram.js";

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: "10mb" }));

// 🔐 Chave simples para proteger execução remota
const BOT_KEY = process.env.AMANABOT_KEY || "amana_dev_key";
const PORT = process.env.PORT || 10000;

// ✅ Healthcheck para Render (resolve erro 502)
app.get("/healthz", (_req, res) => {
  res.status(200).json({
    status: "ok",
    service: "Amana_BOT",
    port: PORT,
    time: new Date().toISOString(),
  });
});

// Página raiz
app.get("/", (_req, res) => {
  res.status(200).json({
    message: "🔥 Amana_BOT online e funcional!",
    docs: ["/healthz", "/amana/test", "/telegram/webhook"],
  });
});

// 🔍 Teste de conectividade com Google APIs
app.get("/amana/test", async (_req, res) => {
  try {
    const auth = await authenticateGoogle();
    const result = await googleTest(auth);
    res.status(200).json({ status: "ok", result });
  } catch (err) {
    res.status(500).json({ status: "erro", message: err.message });
  }
});

// ⚙️ Execução de comandos (SAVE_FILE, SEND_EMAIL, CREATE_EVENT, SAVE_MEMORY)
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
    res.status(500).json({ status: "erro", message: err.message });
  }
});

// 📨 Webhook do Telegram
app.use("/telegram", telegramRouter);

// 🚀 Inicialização
app.listen(PORT, () => console.log(`🚀 Amana_BOT rodando na porta ${PORT}`));

const PORT = process.env.PORT || 3001;
app.use("/telegram", telegramRouter);
app.listen(PORT, () => console.log(`🚀 Amana_BOT rodando na porta ${PORT}`));
