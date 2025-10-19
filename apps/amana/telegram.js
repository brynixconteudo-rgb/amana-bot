// apps/amana/telegram.js
import express from "express";
import axios from "axios";
import bodyParser from "body-parser";
import fs from "fs";
import FormData from "form-data";

import { transcreverAudio, gerarAudio } from "../../voice.js";
import { routeDialog } from "./dialogFlows.js";
import { pushHistory } from "./memory.js";

const router = express.Router();
router.use(bodyParser.json());

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const WEBHOOK_URL = process.env.RENDER_EXTERNAL_URL
  ? `${process.env.RENDER_EXTERNAL_URL}/telegram/webhook`
  : "https://amana-bot.onrender.com/telegram/webhook";

const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;
const TELEGRAM_FILE_API = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}`;
const ENVIAR_AUDIO_RESPOSTA = true;

// ============ CONFIGURAR WEBHOOK ==============
async function setupWebhook() {
  try {
    await axios.post(`${TELEGRAM_API}/setWebhook`, { url: WEBHOOK_URL });
    console.log(`✅ Webhook do Telegram configurado: ${WEBHOOK_URL}`);
  } catch (err) {
    console.error("Erro ao configurar webhook:", err.message);
  }
}

// ========= Safe markdown (Telegram MarkdownV2) =========
const safe = (txt) => String(txt || "").replace(/[_*[\]()~`>#+\-=|{}.!]/g, "\\$&");

// ============ RECEBER MENSAGENS ==============
router.post("/webhook", async (req, res) => {
  const message = req.body.message;
  if (!message) return res.sendStatus(200);

  const chatId = message.chat.id;
  let userText = "";

  try {
    // 🎙️ Voz → transcrição
    if (message.voice) {
      const fileId = message.voice.file_id;
      const fileInfo = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
      const filePath = fileInfo.data.result.file_path;
      const fileUrl = `${TELEGRAM_FILE_API}/${filePath}`;
      userText = await transcreverAudio(fileUrl);
      if (!userText) {
        await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: "❌ Não consegui entender o áudio, pode tentar novamente?",
        });
        return res.sendStatus(200);
      }
    } else if (message.text) {
      userText = message.text.trim();
    } else {
      return res.sendStatus(200);
    }

    // 🧠 histórico mínimo
    await pushHistory(chatId, { role: "user", text: userText });

    // 🎯 processamento principal (fluxo + fallback)
    const reply = await routeDialog(chatId, userText);

    // resposta textual
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text: safe(reply),
      parse_mode: "MarkdownV2",
    });

    // resposta em áudio (opcional)
    if (ENVIAR_AUDIO_RESPOSTA && message.voice) {
      const audioPath = await gerarAudio(reply);
      if (audioPath && fs.existsSync(audioPath)) {
        const form = new FormData();
        form.append("chat_id", chatId);
        form.append("voice", fs.createReadStream(audioPath));
        await axios.post(`${TELEGRAM_API}/sendVoice`, form, { headers: form.getHeaders() });
        fs.unlinkSync(audioPath);
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("❌ Erro no processamento do Telegram:", err.message);
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text: "⚠️ Ocorreu um erro ao processar sua mensagem.",
    });
    res.sendStatus(200);
  }
});

// inicializa webhook
setupWebhook();

export default router;
