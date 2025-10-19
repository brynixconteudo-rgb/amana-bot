// apps/amana/telegram.js
// Webhook Telegram com idempotência (evita duplicados) e áudio opcional.

import express from "express";
import axios from "axios";
import bodyParser from "body-parser";
import fs from "fs";
import FormData from "form-data";
import { processNaturalMessage } from "../../ai.js";
import { transcreverAudio, gerarAudio } from "../../voice.js";

const router = express.Router();
router.use(bodyParser.json());

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const WEBHOOK_URL = process.env.RENDER_EXTERNAL_URL
  ? `${process.env.RENDER_EXTERNAL_URL}/telegram/webhook`
  : "https://amana-bot.onrender.com/telegram/webhook";

const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;
const TELEGRAM_FILE_API = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}`;
const ENVIAR_AUDIO_RESPOSTA = true;

// ====== Idempotência (evita duplicidade) ======
const seenUpdates = new Map(); // key: update_id -> ts
const SEEN_TTL_MS = 5 * 60 * 1000;
function alreadyProcessed(updateId) {
  const now = Date.now();
  for (const [k, ts] of seenUpdates) if (now - ts > SEEN_TTL_MS) seenUpdates.delete(k);
  if (seenUpdates.has(updateId)) return true;
  seenUpdates.set(updateId, now);
  return false;
}

// ============ CONFIGURAR WEBHOOK ==============
async function setupWebhook() {
  try {
    await axios.post(`${TELEGRAM_API}/setWebhook`, { url: WEBHOOK_URL });
    console.log(`✅ Webhook do Telegram configurado: ${WEBHOOK_URL}`);
  } catch (err) {
    console.error("Erro ao configurar webhook:", err.message);
  }
}

// ============ RECEBER MENSAGENS ==============
router.post("/webhook", async (req, res) => {
  // ACK imediato para evitar reenvio do Telegram
  res.sendStatus(200);

  try {
    const update = req.body;
    const updateId = update.update_id;
    if (alreadyProcessed(updateId)) return;

    const message = update.message;
    if (!message) return;

    const chatId = message.chat.id;
    const wasVoice = !!message.voice;
    let userText = "";

    // 🎙️ Voz -> transcrição
    if (message.voice) {
      const fileId = message.voice.file_id;
      const fileInfo = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
      const filePath = fileInfo.data.result.file_path;
      const fileUrl = `${TELEGRAM_FILE_API}/${filePath}`;
      userText = await transcreverAudio(fileUrl);
      if (!userText) {
        await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: "❌ Não consegui entender o áudio. Pode tentar novamente?",
        });
        return;
      }
      console.log("📝 Transcrição:", userText);
    } else if (message.text) {
      userText = message.text.trim();
    } else {
      return;
    }

    // ========= PROCESSO NATURAL COM CONTEXTO =========
    const natural = await processNaturalMessage({ chatId, text: userText });
    const responseText = natural.reply || "Ok.";

    // função para escapar MarkdownV2 do Telegram
    const safe = (txt) => txt.replace(/[_*[\]()~`>#+\-=|{}.!]/g, "\\$&");

    // envia texto
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text: safe(responseText),
      parse_mode: "MarkdownV2",
    });

    // envia áudio SOMENTE se a entrada foi voz
    if (ENVIAR_AUDIO_RESPOSTA && wasVoice) {
      const audioPath = await gerarAudio(responseText);
      if (audioPath && fs.existsSync(audioPath)) {
        const form = new FormData();
        form.append("chat_id", chatId);
        form.append("voice", fs.createReadStream(audioPath));
        await axios.post(`${TELEGRAM_API}/sendVoice`, form, { headers: form.getHeaders() });
        fs.unlinkSync(audioPath);
        console.log("🎤 Áudio enviado com sucesso.");
      }
    }
  } catch (err) {
    console.error("❌ Erro no processamento do Telegram:", err.message);
  }
});

// inicializar webhook ao subir o servidor
setupWebhook();

export default router;
