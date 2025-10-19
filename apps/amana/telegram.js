// apps/amana/telegram.js
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
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;
const TELEGRAM_FILE_API = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}`;
const WEBHOOK_URL = process.env.RENDER_EXTERNAL_URL
  ? `${process.env.RENDER_EXTERNAL_URL}/telegram/webhook`
  : "https://amana-bot.onrender.com/telegram/webhook";

const ENVIAR_AUDIO_RESPOSTA = true;

async function setupWebhook() {
  try {
    await axios.post(`${TELEGRAM_API}/setWebhook`, { url: WEBHOOK_URL });
    console.log(`✅ Webhook do Telegram configurado: ${WEBHOOK_URL}`);
  } catch (err) {
    console.error("Erro ao configurar webhook:", err.message);
  }
}

router.post("/webhook", async (req, res) => {
  const message = req.body.message;
  if (!message) return res.sendStatus(200);

  const chatId = message.chat.id;
  let userText = "";

  try {
    if (message.voice) {
      const fileId = message.voice.file_id;
      const fileInfo = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
      const filePath = fileInfo.data.result.file_path;
      const fileUrl = `${TELEGRAM_FILE_API}/${filePath}`;
      console.log("🎧 Recebido áudio, iniciando transcrição...");
      userText = await transcreverAudio(fileUrl);
      console.log("📝 Transcrição:", userText);
    } else if (message.text) {
      userText = message.text.trim();
    } else return res.sendStatus(200);

    const natural = await processNaturalMessage({ chatId, text: userText });
    const responseText = natural.reply;

    const safe = (txt) => txt.replace(/[_*[\]()~`>#+\-=|{}.!]/g, "\\$&");
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text: safe(responseText),
      parse_mode: "MarkdownV2",
    });

    if (ENVIAR_AUDIO_RESPOSTA && message.voice) {
      const audioPath = await gerarAudio(responseText);
      if (fs.existsSync(audioPath)) {
        const form = new FormData();
        form.append("chat_id", chatId);
        form.append("voice", fs.createReadStream(audioPath));
        await axios.post(`${TELEGRAM_API}/sendVoice`, form, {
          headers: form.getHeaders(),
        });
        fs.unlinkSync(audioPath);
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("❌ Erro no processamento:", err.message);
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text: "⚠️ Ocorreu um erro ao processar sua mensagem.",
    });
    res.sendStatus(200);
  }
});

setupWebhook();
export default router;
