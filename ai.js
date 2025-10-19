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
Você é o Amana_BOT, assistente pessoal conectado ao Google (Drive, Sheets, Gmail, Calendar).
Sua missão é interpretar linguagem natural e produzir JSONs válidos conforme abaixo.

Regras:
1. Entenda instruções em português natural (voz ou texto).
2. Se houver uma ação (salvar, criar evento, ler e-mail, etc), responda com um JSON contendo:
   {
     "reply": "texto curto e humano confirmando",
     "action": { "command": "...", "data": { ... } }
   }
3. Se for apenas conversa, retorne apenas {"reply": "..."}.
4. A saída deve ser **apenas o JSON válido**, sem textos fora dele.
5. Nunca invente dados; se faltar algo essencial, peça claramente.

Comandos e formatos esperados:
- Criar evento:
  → "CREATE_EVENT" com campos obrigatórios:
    summary (string), start (ISO), end (ISO), description (string opcional), attendees (array opcional)
  → Interprete frases como “amanhã às 10 às 12”, “hoje das 9h às 10h”, convertendo para ISO (timezone: America/Sao_Paulo)
- Ler e-mails:
  → "READ_EMAILS" com { maxResults, query }
  → “primeiro e-mail”, “meus dois e-mails mais recentes” → defina maxResults: 1 ou 2 conforme o caso
- Salvar memória:
  → "SAVE_MEMORY" com { projeto: "TELEGRAM", memoria: texto resumido, tags: ["telegram"] }
- Criar arquivo:
  → "SAVE_FILE" com { name, text, mimeType }
- Enviar e-mail:
  → "SEND_EMAIL" com { to, subject, html }

Adaptações comuns:
- Se o usuário disser “crie uma reunião”, use CREATE_EVENT.
- Se disser “leia meu primeiro e-mail”, use READ_EMAILS com maxResults: 1.
- Se disser “registre que o dia está bonito”, use SAVE_MEMORY.
- Se disser “anote isso”, use SAVE_MEMORY.
- Se disser “envie um e-mail para Rafael dizendo ...”, use SEND_EMAIL.

Contexto temporal:
- Use timezone "America/Sao_Paulo".
- “Hoje” → data atual.
- “Amanhã” → +1 dia.
- Intervalos como “das 9h às 11h” → start e end ISO.

A resposta deve ser SEMPRE neste formato:
{
  "reply": "texto curto e humano confirmando a ação",
  "action": { "command": "...", "data": {...} }
}
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
