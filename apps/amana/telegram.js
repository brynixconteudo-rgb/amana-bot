import express from "express";
import axios from "axios";
import bodyParser from "body-parser";
import fs from "fs";
import FormData from "form-data";
import chalk from "chalk";

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

// ====================================================
// 🪝 CONFIGURAÇÃO DO WEBHOOK
// ====================================================
async function setupWebhook() {
  try {
    await axios.post(`${TELEGRAM_API}/setWebhook`, { url: WEBHOOK_URL });
    console.log(chalk.greenBright(`✅ Webhook do Telegram configurado: ${WEBHOOK_URL}`));
  } catch (err) {
    console.error(chalk.red("❌ Erro ao configurar webhook:"), err.message);
  }
}

// ====================================================
// 🔐 SAFE TEXT (para MarkdownV2 do Telegram)
// ====================================================
const safe = (txt) => String(txt || "").replace(/[_*[\]()~`>#+\-=|{}.!]/g, "\\$&");

// ====================================================
// 💬 RECEBE MENSAGENS DO TELEGRAM
// ====================================================
router.post("/webhook", async (req, res) => {
  const message = req.body.message;
  if (!message) return res.sendStatus(200);

  const chatId = message.chat.id;
  let userText = "";

  try {
    // 🎤 Se for áudio → transcreve
    if (message.voice) {
      const fileId = message.voice.file_id;
      const fileInfo = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
      const filePath = fileInfo.data.result.file_path;
      const fileUrl = `${TELEGRAM_FILE_API}/${filePath}`;
      userText = await transcreverAudio(fileUrl);

      console.log(chalk.cyanBright(`🎧 Transcrição recebida: ${userText}`));

      if (!userText) {
        await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: "❌ Não consegui entender o áudio, pode tentar novamente?",
        });
        return res.sendStatus(200);
      }
    }
    // ✉️ Se for texto
    else if (message.text) {
      userText = message.text.trim();
      console.log(chalk.yellow(`💬 Mensagem recebida: "${userText}"`));
    } else {
      return res.sendStatus(200);
    }

    // 📜 Histórico mínimo
    await pushHistory(chatId, { role: "user", text: userText });

    // 🧭 1) Roteamento guiado
    console.log(chalk.gray("🧭 Chamando routeDialog..."));
    const flowReply = await routeDialog(chatId, userText);

    if (flowReply) {
      console.log(chalk.blueBright(`🤖 Resposta routeDialog: ${flowReply}`));

      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text: safe(flowReply),
        parse_mode: "MarkdownV2",
      });

      if (ENVIAR_AUDIO_RESPOSTA && message.voice) {
        const audioPath = await gerarAudio(flowReply);
        if (audioPath && fs.existsSync(audioPath)) {
          const form = new FormData();
          form.append("chat_id", chatId);
          form.append("voice", fs.createReadStream(audioPath));
          await axios.post(`${TELEGRAM_API}/sendVoice`, form, { headers: form.getHeaders() });
          fs.unlinkSync(audioPath);
        }
      }
      return res.sendStatus(200);
    }

    // 🗣️ 2) Conversa natural (fallback)
    console.log(chalk.gray("💬 routeDialog retornou vazio → usando IA natural..."));
    const natural = await processNaturalMessage({ text: userText });
    const responseText = natural.reply || "Ok.";

    console.log(chalk.magentaBright(`💭 IA Natural respondeu: ${responseText}`));

    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text: safe(responseText),
      parse_mode: "MarkdownV2",
    });

    if (ENVIAR_AUDIO_RESPOSTA && message.voice) {
      const audioPath = await gerarAudio(responseText);
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
    console.error(chalk.red("❌ Erro no processamento do Telegram:"), err);
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text: "⚠️ Ocorreu um erro ao processar sua mensagem.",
    });
    res.sendStatus(200);
  }
});

// ====================================================
// 🚀 Inicializa webhook
// ====================================================
setupWebhook();

export default router;
