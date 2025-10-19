// ai.js
// Camada de Linguagem Natural do Amana_BOT com suporte a diálogos guiados e memória
import axios from "axios";
import { authenticateGoogle, runCommand } from "./apps/amana/google.js";
import { handleCreateEvent, handleReadEmails } from "./apps/amana/dialogFlows.js";
import { getDialogState } from "./apps/amana/memory.js";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

const SYSTEM_PROMPT = `
Você é o Amana_BOT, uma assistente pessoal conectada ao Google (Drive, Gmail, Calendar e Sheets).
Seu papel é interpretar a linguagem natural do usuário e decidir se deve:
1. Engajar em uma conversa guiada (ex.: marcar reunião, ler e-mails);
2. Executar uma ação direta (caso já tenha todos os dados);
3. Ou simplesmente responder de forma humana e natural.

Responda APENAS com JSON válido:
{
  "reply": "texto curto e natural para o usuário",
  "intent": "CREATE_EVENT|READ_EMAILS|SAVE_MEMORY|NONE",
  "confidence": 0.0 a 1.0
}
`;

function safeParseJson(text) {
  if (!text) return null;
  try {
    const first = text.indexOf("{");
    const last = text.lastIndexOf("}");
    if (first === -1 || last === -1) return null;
    return JSON.parse(text.slice(first, last + 1));
  } catch {
    return null;
  }
}

async function callOpenAI(text) {
  const payload = {
    model: OPENAI_MODEL,
    temperature: 0.3,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: text }
    ]
  };

  const res = await axios.post(OPENAI_URL, payload, {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
  });

  const content = res.data?.choices?.[0]?.message?.content;
  const parsed = safeParseJson(content);
  return parsed || { reply: "Certo.", intent: "NONE", confidence: 0.3 };
}

export async function processNaturalMessage({ chatId, text }) {
  if (!text?.trim()) return { reply: "Pode repetir?", executedAction: null };

  const state = await getDialogState(chatId);
  let reply = "";
  let executedAction = null;

  // 🔁 1️⃣ Se há um fluxo ativo → continua nele
  if (state.intent === "CREATE_EVENT") {
    reply = await handleCreateEvent(chatId, text);
    return { reply, executedAction };
  }
  if (state.intent === "READ_EMAILS") {
    reply = await handleReadEmails(chatId, text);
    return { reply, executedAction };
  }

  // 🤖 2️⃣ Caso contrário, o modelo decide a intenção
  const ai = await callOpenAI(text);

  switch (ai.intent) {
    case "CREATE_EVENT":
      reply = await handleCreateEvent(chatId, text);
      break;
    case "READ_EMAILS":
      reply = await handleReadEmails(chatId, text);
      break;
    case "SAVE_MEMORY":
      {
        const auth = await authenticateGoogle();
        await runCommand(auth, "SAVE_MEMORY", {
          projeto: "TELEGRAM",
          memoria: text,
          tags: ["telegram"],
        });
        reply = "🧠 Memória registrada!";
      }
      break;
    default:
      reply = ai.reply || "Certo!";
      break;
  }

  return { reply, executedAction };
}
