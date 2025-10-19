import express from "express";
import axios from "axios";
import bodyParser from "body-parser";
import { authenticateGoogle, runCommand } from "./google.js";

const router = express.Router();
router.use(bodyParser.json());

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const BOT_KEY = process.env.AMANABOT_KEY || "amana123";
const WEBHOOK_URL = process.env.RENDER_EXTERNAL_URL
  ? `${process.env.RENDER_EXTERNAL_URL}/telegram/webhook`
  : "https://amana-bot.onrender.com/telegram/webhook";

const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

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
  if (!message || !message.text) return res.sendStatus(200);

  const chatId = message.chat.id;
  const text = message.text.trim();

  try {
    let responseText = "";

    // comandos simples
    if (/^\/start/i.test(text)) {
      responseText =
        "🌙 Olá, eu sou o Amana_BOT.\n\nPosso ler seus e-mails, criar eventos, salvar memórias e arquivos.\nDigite um comando simples como:\n\n`/emails` – ver e-mails não lidos\n`/memoria` – registrar uma memória\n`/evento amanhã` – criar evento teste.";
    }

    // leitura de e-mails
    else if (/^\/emails/i.test(text)) {
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

    // salvar memória simples
    else if (/^\/memoria/i.test(text)) {
      const frase = text.replace("/memoria", "").trim() || "Memória via Telegram.";
      const auth = await authenticateGoogle();
      await runCommand(auth, "SAVE_MEMORY", {
        projeto: "TELEGRAM",
        memoria: frase,
        tags: ["telegram"]
      });
      responseText = "🧠 Memória registrada com sucesso!";
    }

    // criar evento teste
    else if (/^\/evento/i.test(text)) {
      const now = new Date();
      const start = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
      const end = new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString();
      const auth = await authenticateGoogle();
      await runCommand(auth, "CREATE_EVENT", {
        summary: "Evento criado via Telegram",
        start,
        end,
        description: "Evento de teste gerado pelo Amana_BOT via Telegram."
      });
      responseText = "📅 Evento criado com sucesso no seu calendário!";
    }

    // fallback
    else {
      responseText =
        "Desculpe, não entendi 🤔\nTente um dos comandos:\n`/emails`, `/memoria`, `/evento` ou `/start`.";
    }

    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text: responseText,
      parse_mode: "Markdown"
    });

    res.sendStatus(200);
  } catch (err) {
    console.error("Erro no processamento do Telegram:", err.message);
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: message.chat.id,
      text: "⚠️ Ocorreu um erro ao processar seu comando."
    });
    res.sendStatus(200);
  }
});

// inicializar webhook ao subir o servidor
setupWebhook();

export default router;
