// apps/amana/telegram.js
import express from "express";
import axios from "axios";
import bodyParser from "body-parser";
import fs from "fs";
import { authenticateGoogle, runCommand } from "./google.js";
import { processNaturalMessage } from "../../ai.js";
import { transcreverAudio, gerarAudio } from "../../voice.js";

const router = express.Router();
router.use(bodyParser.json());

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const BOT_KEY = process.env.AMANABOT_KEY || "amana123";
const WEBHOOK_URL = process.env.RENDER_EXTERNAL_URL
  ? `${process.env.RENDER_EXTERNAL_URL}/telegram/webhook`
  : "https://amana-bot.onrender.com/telegram/webhook";

const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;
const TELEGRAM_FILE_API = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}`;
const ENVIAR_AUDIO_RESPOSTA = true; // 👈 Se true, Amana responde também em áudio

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
  const message = req.body.message;
  if (!message) return res.sendStatus(200);

  const chatId = message.chat.id;
  let userText = "";

  try {
    // 🎙️ Caso seja mensagem de voz
    if (message.voice) {
      const fileId = message.voice.file_id;
      const fileInfo = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
      const filePath = fileInfo.data.result.file_path;
      const fileUrl = `${TELEGRAM_FILE_API}/${filePath}`;
      console.log("🎧 Recebido áudio, iniciando transcrição...");

      userText = await transcreverAudio(fileUrl);
      if (!userText) {
        await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: chatId,
          text: "❌ Não consegui entender o áudio, pode tentar novamente?",
        });
        return res.sendStatus(200);
      }
      console.log("📝 Transcrição:", userText);
    }

    // 💬 Caso seja texto
    else if (message.text) {
      userText = message.text.trim();
    } else {
      // ignora outros tipos
      return res.sendStatus(200);
    }

    let responseText = "";

    // ============ COMANDOS MANUAIS ============
    if (/^\/start/i.test(userText)) {
      responseText =
        "🌙 Olá, eu sou o Amana_BOT.\n\nPosso ler seus e-mails, criar eventos, salvar memórias e arquivos.\nVocê pode digitar ou enviar um áudio naturalmente. 💬🎧";
    }

    else if (/^\/emails/i.test(userText)) {
      const auth = await authenticateGoogle();
      const result = await runCommand(auth, "READ_EMAILS", { maxResults: 3 });
      if (result.total === 0) {
        responseText = "Nenhum e-mail não lido encontrado 📭";
      } else {
        responseText = `📬 *${result.total} e-mails encontrados:*\n\n`;
        result.emails.forEach((e) => {
          responseText += `• *${e.subject || "(sem assunto)"}*\n  _${e.from}_\n\n`;
        });
      }
    }

    else if (/^\/memoria/i.test(userText)) {
      const frase = userText.replace("/memoria", "").trim() || "Memória via Telegram.";
      const auth = await authenticateGoogle();
      await runCommand(auth, "SAVE_MEMORY", {
        projeto: "TELEGRAM",
        memoria: frase,
        tags: ["telegram"],
      });
      responseText = "🧠 Memória registrada com sucesso!";
    }

    else if (/^\/evento/i.test(userText)) {
      const now = new Date();
      const start = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
      const end = new Date(now.getTime() + 2 * 60 * 1000).toISOString();
      const auth = await authenticateGoogle();
      await runCommand(auth, "CREATE_EVENT", {
        summary: "Evento criado via Telegram",
        start,
        end,
        description: "Evento criado automaticamente via Amana_BOT.",
      });
      responseText = "📅 Evento criado com sucesso no seu calendário!";
    }

    // 🌐 fallback → IA natural
    else {
      const natural = await processNaturalMessage({ text: userText });
      responseText = natural.reply || "Ok.";
    }

    // ============ ENVIO DE RESPOSTA ============

    // função para limpar caracteres problemáticos do Telegram MarkdownV2
    const safe = (txt) => txt.replace(/[_*[\]()~`>#+\-=|{}.!]/g, "\\$&");

    // envia resposta textual
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text: safe(responseText),
      parse_mode: "MarkdownV2",
    });

    // se habilitado, também envia resposta em áudio
    if (ENVIAR_AUDIO_RESPOSTA) {
      const audioPath = await gerarAudio(responseText);
      if (audioPath && fs.existsSync(audioPath)) {
        const audio = fs.createReadStream(audioPath);
        const form = new FormData();
        form.append("chat_id", chatId);
        form.append("voice", audio);
        await axios.post(`${TELEGRAM_API}/sendVoice`, form, {
          headers: form.getHeaders(),
        });
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

// inicializar webhook ao subir o servidor
setupWebhook();

export default router;
