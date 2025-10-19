// apps/amana/telegram.js
import express from "express";
import axios from "axios";
import bodyParser from "body-parser";
import fs from "fs";
import FormData from "form-data";
import { authenticateGoogle, runCommand } from "./google.js";
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
const ENVIAR_AUDIO_RESPOSTA = true; // ativa resposta por voz

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
  let respostaGerada = ""; // armazenar o que Amana responderá

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
    } else if (message.text) {
      userText = message.text.trim();
    } else {
      return res.sendStatus(200);
    }

    // ============ INTERPRETAÇÃO / EXECUÇÃO ============
    let responseText = "";

    if (/^\/start/i.test(userText)) {
      responseText =
        "🌙 Olá, eu sou o Amana_BOT.\n\nPosso ler seus e-mails, criar eventos, salvar memórias e arquivos.\nVocê pode digitar ou enviar um áudio naturalmente. 💬🎧";
    } 
    else if (/^\/emails/i.test(userText)) {
      const auth = await authenticateGoogle();
      const result = await runCommand(auth, "READ_EMAILS", { maxResults: 3 });
      if (result.total === 0) responseText = "Nenhum e-mail não lido encontrado 📭";
      else {
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
      const end = new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString();
      const auth = await authenticateGoogle();
      await runCommand(auth, "CREATE_EVENT", {
        summary: "Evento criado via Telegram",
        start,
        end,
        description: "Evento criado automaticamente via Amana_BOT.",
      });
      responseText = "📅 Evento criado com sucesso no seu calendário!";
    } 
    else {
      // 🌐 Conversa natural via IA
      const natural = await processNaturalMessage({ text: userText });
      responseText = natural.reply || "Ok.";

      // ✅ Se IA gerou uma ação, executa
      if (natural.executedAction && natural.executedAction.command) {
        console.log("⚙️ Ação executada:", natural.executedAction.command);
      }
    }

    respostaGerada = responseText;

    // ============ ENVIO DE RESPOSTA ============
    const safe = (txt) => txt.replace(/[_*[\]()~`>#+\-=|{}.!]/g, "\\$&");

    // envia texto
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text: safe(respostaGerada),
      parse_mode: "MarkdownV2",
    });

    // envia áudio apenas se foi originado por voz
    if (ENVIAR_AUDIO_RESPOSTA && message.voice) {
      const audioPath = await gerarAudio(respostaGerada);
      if (audioPath && fs.existsSync(audioPath)) {
        const form = new FormData();
        form.append("chat_id", chatId);
        form.append("voice", fs.createReadStream(audioPath));

        await axios.post(`${TELEGRAM_API}/sendVoice`, form, {
          headers: form.getHeaders(),
        });

        fs.unlinkSync(audioPath);
        console.log("🎤 Áudio enviado com sucesso.");
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

setupWebhook();
export default router;
