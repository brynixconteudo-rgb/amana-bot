// ai.js
// Camada de Linguagem Natural do Amana_BOT
// - Interpreta texto livre (ex.: do Telegram) usando OpenAI
// - Decide entre resposta textual e/ou acionar comandos (Drive/Sheets/Gmail/Calendar)
// - Executa comando via google.js quando necessário
//
// Como usar (no telegram.js):
//   import { processNaturalMessage } from "../../ai.js";
//   const { text: userText } = message;
//   const botReply = await processNaturalMessage({ text: userText });
//   -> botReply.reply  (mensagem para o usuário)
//   -> botReply.executedAction (dados opcionais da ação executada)
//
// Requisitos:
//   - Variável de ambiente: OPENAI_API_KEY
//   - Dependências: axios (já no package.json)
//   - Integrações existentes: authenticateGoogle/runCommand de apps/amana/google.js

import axios from "axios";
import { authenticateGoogle, runCommand } from "./apps/amana/google.js";

// ---------- Config ----------
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

// Instruções do sistema (resumo das regras do Amana_BOT)
const SYSTEM_PROMPT = `
Você é o Amana_BOT, um assistente pessoal com dois canais (Telegram e ChatGPT).
Regras centrais:
1) Entenda linguagem natural do usuário. Responda de forma breve, clara e amigável.
2) Quando a intenção exigir ação nas integrações Google (Drive/Sheets/Gmail/Calendar), produza um objeto JSON no formato abaixo em "action".
3) Se a intenção for apenas conversar/responder, retorne só o "reply" (sem "action").
4) Não invente dados. Se algo estiver faltando, peça de forma objetiva.
5) Todos os dados persistentes devem ser salvos pelo BOT (não por você localmente). O BOT registra tudo em Amana_INDEX.json.

Formato DE RESPOSTA (JSON **válido** SEM texto extra):
{
  "reply": "mensagem de resposta ao usuário",
  "action": {
    "command": "SAVE_FILE|SEND_EMAIL|CREATE_EVENT|SAVE_MEMORY|READ_EMAILS",
    "data": { ...campos necessários... }
  }
}

Mapeamentos:
- "salvar arquivo", "anexa isso", "guarde este texto" -> SAVE_FILE { name, mimeType?, text? ou base64? }
- "enviar e-mail" -> SEND_EMAIL { to, subject, html }
- "criar evento" -> CREATE_EVENT { summary, start, end, attendees?, location?, description? }
- "registrar memória" -> SAVE_MEMORY { projeto, memoria, tags?[] }
- "ler e-mails importantes" -> READ_EMAILS { maxResults?, query? }

Dicas de extração:
- Datas: usar ISO com timezone se possível (ex.: 2025-10-21T09:00:00-03:00).
- "amanhã às 9h" -> converta para ISO se o usuário fornecer o fuso (ex.: America/Sao_Paulo).
- Mantenha o "reply" sempre humano e confirmatório; e o "action" apenas quando realmente for necessário executar algo.

IMPORTANTE:
- A saída DEVE ser APENAS o JSON e válido. Não inclua comentários, markdown, ou textos fora do JSON.
`;

// ---------- Utilitário para extrair JSON robustamente ----------
function safeParseJson(maybeJson) {
  if (typeof maybeJson !== "string") return null;
  const first = maybeJson.indexOf("{");
  const last = maybeJson.lastIndexOf("}");
  if (first === -1 || last === -1 || last < first) return null;
  const slice = maybeJson.slice(first, last + 1);
  try {
    return JSON.parse(slice);
  } catch {
    return null;
  }
}

// ---------- Chamada OpenAI ----------
async function callOpenAI(userText) {
  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY ausente no ambiente.");
  }

  const payload = {
    model: OPENAI_MODEL,
    temperature: 0.2,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userText }
    ]
  };

  const res = await axios.post(OPENAI_URL, payload, {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    timeout: 30000
  });

  const content = res?.data?.choices?.[0]?.message?.content || "";
  const parsed = safeParseJson(content);
  if (!parsed || typeof parsed.reply !== "string") {
    // fallback mínimo: retorna resposta textual simples
    return { reply: content?.trim() || "Ok.", action: null };
  }
  return parsed;
}

// ---------- Execução de ação (se houver) ----------
async function maybeExecuteAction(naturalResult) {
  const { action } = naturalResult || {};
  if (!action || !action.command) return { executedAction: null };

  // Autenticar Google e executar via runCommand
  const auth = await authenticateGoogle();
  const execResult = await runCommand(auth, action.command, action.data || {});
  return { executedAction: { command: action.command, result: execResult } };
}

// ---------- API pública ----------
/**
 * Processa uma mensagem natural (ex.: texto vindo do Telegram)
 * @param {{ text: string }} param0
 * @returns {Promise<{ reply: string, executedAction: null | { command: string, result: any } }>}
 */
export async function processNaturalMessage({ text }) {
  if (!text || !text.trim()) {
    return { reply: "Pode repetir? Não entendi a mensagem.", executedAction: null };
  }

  // Chama a OpenAI para interpretar intenção
  const nl = await callOpenAI(text);

  // Se houver ação (ex.: criar evento), executa de fato
  const { executedAction } = await maybeExecuteAction(nl);

  // Resposta final para o usuário
  return {
    reply: nl.reply || "Ok.",
    executedAction: executedAction || null
  };
}

// ---------- Helper opcional: prompt de depuração local ----------
export async function debugInterpretationExample() {
  const ex = await callOpenAI("Crie um evento amanhã às 9h com o Rafael sobre proposta X. Me confirme.");
  return ex;
}
