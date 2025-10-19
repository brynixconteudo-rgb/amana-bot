import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import { authenticateGoogle, googleTest } from "./apps/amana/google.js";

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: "10mb" }));

// 🧠 Teste de vida do BOT
app.get("/", (req, res) => {
  res.send("🔥 Amana_BOT online e funcional!");
});

// 🧩 Teste de conexão com Google APIs
app.get("/amana/test", async (req, res) => {
  try {
    const auth = await authenticateGoogle();
    const result = await googleTest(auth);
    res.status(200).json({ status: "ok", result });
  } catch (err) {
    res.status(500).json({ status: "erro", message: err.message });
  }
});

// 🔜 Em breve: /amana/exec, /amana/context, etc.

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`🚀 Amana_BOT rodando na porta ${PORT}`));
