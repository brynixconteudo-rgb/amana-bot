// ai.js — versão corrigida e aprimorada
import axios from "axios";
import { authenticateGoogle, runCommand } from "./apps/amana/google.js";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

// ---------- PROMPT PRINCIPAL ----------
const SYSTEM_PROMPT = `
Você é o Amana_BOT, assistente pessoal conectado ao Google (Drive, Sheets, Gmail e Calendar).
Sua função é interpretar pedidos naturais (texto ou voz) e gerar comandos JSON válidos.

Formato de resposta:
{
  "reply": "texto curto e humano confirmando a ação",
  "action": { "command": "...", "data": { ... } }
}

Regras:
- Se for apenas conversa, retorne só {"reply": "..."}.
- Nunca invente dados; se faltar algo essencial (ex: horário ou pessoa), peça no "reply".
- Sempre use timezone "America/Sao_Paulo" e formato ISO em datas.

Comandos:
- "crie uma reunião amanhã das 10 às 12 com Rafael" → CREATE_EVENT { summary, start, end, attendees:["rafael@..."], description }
- "leia meus dois primeiros e-mails" → READ_EMAILS { maxResults: 2 }
- "registre uma memória dizendo que o dia está bonito" → SAVE_MEMORY { projeto:"TELEGRAM", memoria:"O dia está bonito", tags:["telegram"] }
- "salve um arquivo chamado notas.txt com o texto ..." → SAVE_FILE { name, text, mimeType:"text/plain" }
- "envie um e-mail para Rafael dizendo ..." → SEND_EMAIL { to, subject, html }

Contexto temporal:
- “Hoje” → data atual; “amanhã” → +1 dia.
- Intervalos “das 9h às 11h” → start/end ISO com fuso -03:00.
- Se não houver horário, defina 1h de duração.

A saída deve ser **somente o JSON válido**, sem markdown nem explicações.
`;

// ---------- JSON seguro ----------
function safeParseJson(str) {
  if (typeof str !== "string") return null;
  const first = str.indexOf("{");
  const last = str.lastIndexOf("}");
  if (first === -1 || last === -1 || last < first) return null;
  const json = str.slice(first, last + 1);
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

// ---------- Chamada à OpenAI ----------
async function callOpenAI(userText) {
  const res = await axios.post(
    OPENAI_URL,
    {
      model: OPENAI_MODEL,
      temperature: 0.2,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userText }
      ]
    },
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      timeout: 30000
    }
  );

  const content = res?.data?.choices?.[0]?.message?.content || "";
  const parsed = safeParseJson(content);
  if (!parsed || typeof parsed.reply !== "string") {
    return { reply: content?.trim() || "Ok.", action: null };
  }
  return parsed;
}

// ---------- Execução condicional ----------
async function maybeExecuteAction(naturalResult) {
  const { action } = naturalResult || {};
  if (!action?.command) return { executedAction: null };

  const auth = await authenticateGoogle();

  // ⚙️ Completa campos obrigatórios ausentes
  if (action.command === "READ_EMAILS" && !action.data?.maxResults)
    action.data.maxResults = 3;

  if (action.command === "CREATE_EVENT") {
    const now = new Date();
    if (!action.data.start)
      action.data.start = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
    if (!action.data.end)
      action.data.end = new Date(now.getTime() + 2 * 60 * 1000).toISOString();
    if (!action.data.summary)
      action.data.summary = "Evento criado via Amana_BOT";
  }

  const result = await runCommand(auth, action.command, action.data || {});
  return { executedAction: { command: action.command, result } };
}

// ---------- Função principal ----------
export async function processNaturalMessage({ text }) {
  if (!text?.trim())
    return { reply: "Pode repetir? Não entendi.", executedAction: null };

  const nl = await callOpenAI(text);
  const { executedAction } = await maybeExecuteAction(nl);

  // 📬 Ajuste de resposta dinâmica pós-execução
  let reply = nl.reply || "Ok.";
  if (executedAction) {
    switch (executedAction.command) {
      case "CREATE_EVENT":
        reply = "📅 Reunião criada com sucesso no calendário!";
        break;
      case "READ_EMAILS":
        if (executedAction.result?.emails?.length > 0) {
          reply =
            "📨 Aqui estão os e-mails:\n\n" +
            executedAction.result.emails
              .map((e, i) => `${i + 1}. ${e.subject || "(sem assunto)"} – ${e.from}`)
              .join("\n");
        } else {
          reply = "📭 Nenhum e-mail encontrado.";
        }
        break;
      case "SAVE_MEMORY":
        reply = "🧠 Memória registrada com sucesso!";
        break;
    }
  }

  return { reply, executedAction: executedAction || null };
}

// ---------- Teste local opcional ----------
export async function debugInterpretationExample() {
  const ex = await callOpenAI("Crie um evento amanhã às 9h com o Rafael sobre proposta X. Me confirme.");
  return ex;
}
