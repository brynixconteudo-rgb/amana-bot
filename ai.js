// ai.js
// Orquestrador de diálogo do Amana_BOT com persistência por chatId.
// - Faz slot-filling para CREATE_EVENT, READ_EMAILS e SEND_EMAIL.
// - Usa memory.js (intent, fields, stage, history).
// - Só executa a ação quando todos os campos obrigatórios estão preenchidos.
// - Ao concluir, chama endTask(chatId) para não ficar preso no fluxo.

import axios from "axios";
import { authenticateGoogle, runCommand } from "./apps/amana/google.js";
import {
  loadContext,
  updateContext,
  beginTask,
  endTask,
  pushHistory,
  getDialogState,
} from "./apps/amana/memory.js";

// ========== OpenAI ==========
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

async function callOpenAI(prompt) {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY ausente");
  const res = await axios.post(
    OPENAI_URL,
    {
      model: OPENAI_MODEL,
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content:
            "Você extrai intenção e campos a partir de linguagem natural em pt-BR. Responda apenas JSON válido.",
        },
        { role: "user", content: prompt },
      ],
    },
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      timeout: 30000,
    }
  );
  const content = res?.data?.choices?.[0]?.message?.content || "{}";
  try {
    const first = content.indexOf("{");
    const last = content.lastIndexOf("}");
    return JSON.parse(content.slice(first, last + 1));
  } catch {
    return {};
  }
}

// ========== Util ==========
function asISO(dateStr, timeStr, tz = "-03:00") {
  // rápida conversão "2025-10-19" + "16:00" => "2025-10-19T16:00:00-03:00"
  if (!dateStr || !timeStr) return null;
  const hhmm = timeStr.match(/^\d{1,2}:\d{2}$/) ? timeStr : null;
  if (!hhmm) return null;
  const [h, m] = hhmm.split(":");
  return `${dateStr}T${String(h).padStart(2, "0")}:${m}:00${tz}`;
}

function normalizeEmail(e) {
  if (!e) return null;
  return e.includes("@") ? e.trim() : null;
}

function isCompleteEvent(fields) {
  return !!(fields?.summary && fields?.startISO && fields?.endISO);
}

function needEmailReadParams(fields) {
  // precisa pelo menos maxResults (default 1) e/ou query (opcional)
  return !fields?.maxResults && !fields?.query;
}

function isCompleteSendEmail(fields) {
  return !!(normalizeEmail(fields?.to) && fields?.subject && fields?.html);
}

// ========== Slot filling por intenção ==========
async function fillForCreateEvent(chatId, userText) {
  const { fields = {}, stage } = await getDialogState(chatId);

  // 1) tentar extrair algo novo do texto
  const extract = await callOpenAI(`
Extraia campos para criar um evento a partir do texto abaixo:
Texto: """${userText}"""
Responda em JSON: { "summary": string?, "date": "YYYY-MM-DD"?, "startTime": "HH:MM"?, "endTime": "HH:MM"?, "attendees": [string emails]? }
Se não tiver, deixe ausente.
`);
  const next = { ...fields };

  if (extract.summary && !next.summary) next.summary = extract.summary;
  if (extract.date) next.date = extract.date;
  if (extract.startTime) next.startTime = extract.startTime;
  if (extract.endTime) next.endTime = extract.endTime;
  if (Array.isArray(extract.attendees) && extract.attendees.length) {
    next.attendees = extract.attendees;
  }

  // montar ISO se der
  if (next.date && next.startTime) next.startISO = asISO(next.date, next.startTime);
  if (next.date && next.endTime) next.endISO = asISO(next.date, next.endTime);

  // perguntas pendentes
  if (!next.summary) {
    await updateContext(chatId, { intent: "CREATE_EVENT", fields: next, stage: "awaiting_summary" });
    return { ask: "Qual é o título da reunião?" };
  }
  if (!next.date) {
    await updateContext(chatId, { intent: "CREATE_EVENT", fields: next, stage: "awaiting_date" });
    return { ask: "Para qual dia é a reunião? (formato AAAA-MM-DD)" };
  }
  if (!next.startTime) {
    await updateContext(chatId, { intent: "CREATE_EVENT", fields: next, stage: "awaiting_start" });
    return { ask: "Qual o horário de início? (HH:MM)" };
  }
  if (!next.endTime) {
    await updateContext(chatId, { intent: "CREATE_EVENT", fields: next, stage: "awaiting_end" });
    return { ask: "Qual o horário de término? (HH:MM)" };
  }

  // attendees opcionais; se o usuário disse "com o Rafael", peça e-mail
  if (!next.attendeesEmailAsked && /com\s+o|a|@/i.test(userText)) {
    await updateContext(chatId, {
      intent: "CREATE_EVENT",
      fields: { ...next, attendeesEmailAsked: true },
      stage: "awaiting_attendees",
    });
    return { ask: "Quer convidar alguém? Se sim, informe os e-mails separados por vírgula. (ou diga 'só eu')" };
  }

  // se disse "só eu", zera attendees
  if (/s[oó]\s*eu\b/i.test(userText)) {
    next.attendees = [];
  }

  // pronto para executar?
  if (isCompleteEvent(next)) {
    const auth = await authenticateGoogle();
    const data = {
      summary: next.summary,
      start: next.startISO,
      end: next.endISO,
      description: next.description || "",
      attendees: Array.isArray(next.attendees)
        ? next.attendees.filter(Boolean)
        : [],
    };
    const result = await runCommand(auth, "CREATE_EVENT", data);
    await endTask(chatId);
    return { done: `Pronto! Reunião “${data.summary}” criada de ${next.startTime} às ${next.endTime}.`, result };
  }

  // fallback
  await updateContext(chatId, { intent: "CREATE_EVENT", fields: next });
  return { ask: "Certo! Me diga a data (AAAA-MM-DD) e os horários (HH:MM) de início e fim." };
}

async function fillForReadEmails(chatId, userText) {
  const { fields = {} } = await getDialogState(chatId);

  // extrair "primeiro", "dois", "3", etc.
  const extract = await callOpenAI(`
Quantos e-mails ler? Texto: """${userText}"""
Responda JSON: { "maxResults": number?, "query": string? }.
Use maxResults=1 se disser "primeiro".
`);
  const next = { ...fields };

  if (extract.maxResults) next.maxResults = Math.min(10, Math.max(1, Number(extract.maxResults)));
  if (extract.query) next.query = String(extract.query);

  if (!next.maxResults && !next.query) {
    await updateContext(chatId, { intent: "READ_EMAILS", fields: next, stage: "awaiting_email_params" });
    return { ask: "Você quer que eu leia quantos? Posso ler 1, 2 ou mais. Quer filtrar por algo (ex.: is:unread, from:fulano)?" };
  }

  const auth = await authenticateGoogle();
  const data = { maxResults: next.maxResults || 1, query: next.query || "in:inbox" };
  const result = await runCommand(auth, "READ_EMAILS", data);

  await endTask(chatId);

  if (!result || result.total === 0) {
    return { done: "Li e não encontrei e-mails com esse critério." };
  }

  const lines = result.emails.slice(0, data.maxResults).map(
    (e, i) => `${i + 1}) ${e.subject || "(sem assunto)"} — ${e.from || ""}`
  );
  return { done: `Aqui vai:\n${lines.join("\n")}`, result };
}

async function fillForSendEmail(chatId, userText) {
  const { fields = {} } = await getDialogState(chatId);
  const extract = await callOpenAI(`
Extraia dados para envio de e-mail do texto:
"""${userText}"""
Responda JSON: { "to": string?, "subject": string?, "html": string? }.
`);
  const next = { ...fields };
  if (extract.to && !next.to) next.to = extract.to;
  if (extract.subject && !next.subject) next.subject = extract.subject;
  if (extract.html && !next.html) next.html = extract.html;

  if (!normalizeEmail(next.to)) {
    await updateContext(chatId, { intent: "SEND_EMAIL", fields: next, stage: "awaiting_to" });
    return { ask: "Qual e-mail do destinatário?" };
  }
  if (!next.subject) {
    await updateContext(chatId, { intent: "SEND_EMAIL", fields: next, stage: "awaiting_subject" });
    return { ask: "Qual é o assunto?" };
  }
  if (!next.html) {
    await updateContext(chatId, { intent: "SEND_EMAIL", fields: next, stage: "awaiting_html" });
    return { ask: "O que devo escrever no corpo do e-mail?" };
  }

  if (isCompleteSendEmail(next)) {
    const auth = await authenticateGoogle();
    const data = { to: next.to, subject: next.subject, html: next.html };
    const result = await runCommand(auth, "SEND_EMAIL", data);
    await endTask(chatId);
    return { done: `E-mail enviado para ${data.to} com assunto “${data.subject}”.`, result };
  }

  await updateContext(chatId, { intent: "SEND_EMAIL", fields: next });
  return { ask: "Quase lá. Falta destinatário, assunto e corpo do e-mail." };
}

// ========== Intenção inicial ==========
async function detectIntent(userText) {
  const guess = await callOpenAI(`
Identifique a intenção principal do pedido abaixo. Responda JSON:
{ "intent": "CREATE_EVENT"|"READ_EMAILS"|"SEND_EMAIL"|"SAVE_MEMORY"|"NONE" }
Texto: """${userText}"""
`);
  const intent = guess.intent || "NONE";
  return intent;
}

// ========== API pública ==========
/**
 * Processa uma mensagem natural persistente.
 * @param {{ chatId: string|number, text: string }} param0
 */
export async function processNaturalMessage({ chatId, text }) {
  const msg = String(text || "").trim();
  if (!msg) return { reply: "Pode repetir? Não entendi.", executedAction: null };

  await pushHistory(chatId, { role: "user", text: msg });

  // Estado atual
  const ctx = await loadContext(chatId);
  let { intent, fields = {}, stage } = ctx.context || {};

  // Se não há intenção ativa, detectar
  if (!intent || intent === "NONE") {
    intent = await detectIntent(msg);

    // SAVE_MEMORY é direta
    if (intent === "SAVE_MEMORY") {
      const auth = await authenticateGoogle();
      const memoria = msg.replace(/^(amana|mana|ramana)[,:]?\s*/i, "");
      const result = await runCommand(auth, "SAVE_MEMORY", {
        projeto: "TELEGRAM",
        memoria,
        tags: ["telegram"],
      });
      await endTask(chatId);
      await pushHistory(chatId, { role: "bot", text: "Memória registrada. ✅" });
      return { reply: "Anotado! ✅", executedAction: { command: "SAVE_MEMORY", result } };
    }

    // Se for NONE, conversa normal
    if (intent === "NONE") {
      await endTask(chatId);
      await pushHistory(chatId, { role: "bot", text: "Certo! Como posso ajudar?" });
      return { reply: "Certo! Como posso ajudar?", executedAction: null };
    }

    await beginTask(chatId, intent, {});
    fields = {};
    stage = null;
  }

  // Roteamento por intenção ativa (slot-filling)
  let out;
  if (intent === "CREATE_EVENT") {
    out = await fillForCreateEvent(chatId, msg);
  } else if (intent === "READ_EMAILS") {
    out = await fillForReadEmails(chatId, msg);
  } else if (intent === "SEND_EMAIL") {
    out = await fillForSendEmail(chatId, msg);
  } else {
    await endTask(chatId);
    out = { done: "Certo! O que mais posso fazer?" };
  }

  const reply = out?.ask || out?.done || "Ok.";
  await pushHistory(chatId, { role: "bot", text: reply });

  if (out?.result) {
    return { reply, executedAction: { command: intent, result: out.result } };
  }
  return { reply, executedAction: null };
}
