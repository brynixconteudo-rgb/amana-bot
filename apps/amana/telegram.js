// apps/amana/telegram.js
// 🔧 Versão com logs detalhados (instrumentação completa)

import express from "express";
import axios from "axios";
import bodyParser from "body-parser";
import fs from "fs";
import FormData from "form-data";
import { processNaturalMessage } from "../../ai.js";
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

// ============================================
// 📡 CONFIGURAÇÃO DO WEBHOOK
// ============================================
async function setupWebhook() {
  try {
    await axios.post(`${TELEGRAM_API}/setWebhook`, { url: WEBHOOK_URL });
    console.log(`✅ [SETUP] Webhook do Telegram configurado: ${WEBHOOK_URL}`);
  } catch (err) {
    console.error("❌ [SETUP] Erro ao configurar webhook:", err.message);
  }
}

// ============================================
// ⚙️ SANITIZAÇÃO DE TEXTO PARA TELEGRAM
// ============================================
const safe = (txt) => String(txt || "").replace(/[_*[\]()~`>#+\-=|{}.!]/g, "\\$&");

// ============================================
// 💬 RECEBIMENTO DE MENSAGENS
// ============================================
router.post("/webhook", async (req, res) => {
  const message = req.body.message;
  if (!message) return res.sendStatus(200);

  const chatId = message.chat.id;
  let userText = "";

  console.log("💬 [TELEGRAM] Mensagem recebida:", JSON.stringify(message.text || "(áudio)"));

  try {
    // 🎙️ Se for voz → transcreve
    if (message.voice) {
      const fileId = message.voice.file_id;
      const fileInfo = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
      const filePath = fileInfo.data.result.file_path;
      const fileUrl = `${TELEGRAM_FILE_API}/${filePath}`;
      userText = await transcreverAudio(fileUrl);

      console.log("🎧 [TRANSCRIÇÃO] Texto obtido:", userText);

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
      console.warn("⚠️ [TELEGRAM] Mensagem ignorada (sem texto ou voz)");
      return res.sendStatus(200);
    }

    // 🔍 Loga histórico
    await pushHistory(chatId, { role: "user", text: userText });
    console.log(`🧠 [MEMÓRIA] Histórico atualizado para chatId=${chatId}`);

    // 🧭 Chama o roteador
    console.log("🧭 [ROUTER] Chamando routeDialog...");
    const flowReply = await routeDialog(chatId, userText);
    console.log("🧭 [ROUTER] Resposta recebida:", flowReply);

    // 📨 Responde o fluxo (ou fallback)
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text: safe(flowReply),
      parse_mode: "MarkdownV2",
    });

    // 🔊 Se houver áudio, envia também
    if (ENVIAR_AUDIO_RESPOSTA && message.voice) {
      const audioPath = await gerarAudio(flowReply);
      if (audioPath && fs.existsSync(audioPath)) {
        console.log("🎤 [AUDIO] Enviando áudio de resposta...");
        const form = new FormData();
        form.append("chat_id", chatId);
        form.append("voice", fs.createReadStream(audioPath));
        await axios.post(`${TELEGRAM_API}/sendVoice`, form, { headers: form.getHeaders() });
        fs.unlinkSync(audioPath);
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("❌ [ERRO TELEGRAM] Falha geral:", err.message);
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text: "⚠️ Ocorreu um erro ao processar sua mensagem.",
    });
    res.sendStatus(200);
  }
});

setupWebhook();

export default router;
