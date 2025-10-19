// server.js
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

// ✅ Healthcheck para Render (resolve erro 502 e health timeout)
app.get("/healthz", (_req, res) => {
  res.status(200).json({
    status: "ok",
    service: "Amana_BOT",
    port: PORT,
    timestamp: new Date().toISOString(),
  });
});

// 🌐 Página raiz
app.get("/", (_req, res) => {
  res.status(200).json({
    message: "🔥 Amana_BOT online e funcional!",
    endpoints: {
      health: "/healthz",
      test: "/amana/test",
      telegram: "/telegram/webhook",
      exec: "/amana/exec"
    },
  });
});

// 🔍 Teste de conectividade com Google APIs
app.get("/amana/test", async (_req, res) => {
  try {
    const auth = await authenticateGoogle();
    const result = await googleTest(auth);
    res.status(200).json({ status: "ok", result });
  } catch (err) {
    console.error("❌ Erro em /amana/test:", err.message);
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
    console.error("❌ Erro em /amana/exec:", err.message);
    res.status(500).json({ status: "erro", message: err.message });
  }
});

// 📨 Webhook do Telegram
app.use("/telegram", telegramRouter);

// 🚀 Inicialização do servidor
app.listen(PORT, () => {
  console.log(`🚀 Amana_BOT rodando na porta ${PORT}`);
  console.log(`✅ Healthcheck ativo em http://localhost:${PORT}/healthz`);
});
