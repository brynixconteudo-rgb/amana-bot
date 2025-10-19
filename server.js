import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import { authenticateGoogle, googleTest, runCommand } from "./apps/amana/google.js";

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: "10mb" }));

// 🔐 chave simples para proteger a execução remota
const BOT_KEY = process.env.AMANABOT_KEY || "amana_dev_key";

app.get("/", (_req, res) => {
  res.send("🔥 Amana_BOT online e funcional!");
});

// teste de conectividade com Google APIs
app.get("/amana/test", async (_req, res) => {
  try {
    const auth = await authenticateGoogle();
    const result = await googleTest(auth);
    res.status(200).json({ status: "ok", result });
  } catch (err) {
    res.status(500).json({ status: "erro", message: err.message });
  }
});

// execução de comandos (SAVE_FILE, SEND_EMAIL, CREATE_EVENT, SAVE_MEMORY)
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

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`🚀 Amana_BOT rodando na porta ${PORT}`));
