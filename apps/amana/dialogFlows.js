// apps/amana/dialogFlows.js
// Motor de diálogo guiado do Amana_BOT — versão revisada 2025-10-19
// Coleta progressiva de dados (slot-filling) e finalização automática.
// Integra com memory.js (persistência) e google.js (execução).

import { authenticateGoogle, runCommand } from "./google.js";
import { getDialogState, updateContext, endTask } from "./memory.js";
import { set } from "date-fns";

// ======== utilitários =====================================================

function extractHoursPT(text) {
  const t = text.normalize("NFD").replace(/\p{Diacritic}/gu, "");
  const range = t.match(/\b(\d{1,2})(?::(\d{2}))?\s*(h|hrs|horas)?\s*(ate|as|a)\s*(\d{1,2})(?::(\d{2}))?/);
  if (range) {
    const sh = parseInt(range[1], 10);
    const sm = parseInt(range[2] ?? "0", 10);
    const eh = parseInt(range[5], 10);
    const em = parseInt(range[6] ?? "0", 10);
    return { startHour: sh, startMin: sm, endHour: eh, endMin: em };
  }
  const single = t.match(/\bas\s*(\d{1,2})(?::(\d{2}))?\s*(h|hrs|horas)?\b/);
  if (single) {
    const sh = parseInt(single[1], 10);
    const sm = parseInt(single[2] ?? "0", 10);
    return { startHour: sh, startMin: sm };
  }
  return null;
}

function nextDate(label) {
  const now = new Date();
  if (/amanh[aã]/i.test(label)) return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  if (/depois de amanh[aã]/i.test(label)) return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 2);
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function normalizeEmails(input) {
  if (!input) return [];
  const items = Array.isArray(input) ? input : [input];
  return items
    .map((v) => (typeof v === "string" ? v.trim() : v?.email?.trim()))
    .filter(Boolean)
    .filter((v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v));
}

// ======== fluxo principal ================================================

export async function handleCreateEvent(chatId, text) {
  const state = await getDialogState(chatId);
  const fields = { ...(state.fields || {}) };

  // --- preencher slots com o texto recebido ------------------------------
  if (!fields.summary) {
    const m = text.match(/t[ií]tulo\s+(.*)$/i) || text.match(/assunto\s+(.*)$/i);
    fields.summary = m?.[1]?.trim() || fields.summary;
    if (!fields.summary) {
      const m2 = text.match(/reuni[aã]o\s+(geral|alinhamento|.*)$/i);
      if (m2) fields.summary = `Reunião ${m2[1]}`.trim();
    }
  }

  if (!fields.date) {
    if (/amanh[aã]/i.test(text)) fields.date = "amanha";
    else if (/hoje/i.test(text)) fields.date = "hoje";
  }

  const hours = extractHoursPT(text);
  if (hours) {
    fields.startHour = hours.startHour ?? fields.startHour;
    fields.startMin = hours.startMin ?? fields.startMin ?? 0;
    fields.endHour = hours.endHour ?? fields.endHour;
    fields.endMin = hours.endMin ?? fields.endMin ?? 0;
  }

  if (!fields.attendees) {
    if (/apenas eu|s[oó] eu|somente eu/i.test(text)) fields.attendees = [];
    else {
      const mails = (text.match(/[^\s@]+@[^\s@]+\.[^\s@]+/g) || []).slice(0, 10);
      if (mails.length) fields.attendees = mails;
    }
  }

  await updateContext(chatId, { intent: "CREATE_EVENT", fields });

  // --- perguntar apenas o que falta --------------------------------------
  if (!fields.summary)
    return "Qual é o título da reunião?";
  if (!fields.date)
    return "Para que dia é essa reunião? (hoje, amanhã ou data específica)";
  if (fields.startHour == null || (fields.endHour == null && !fields.duration))
    return "Qual o horário? (ex.: das 16h às 17h)";
  // todos preenchidos → criar evento
  try {
    const base = nextDate(fields.date);
    const start = set(base, {
      hours: fields.startHour,
      minutes: fields.startMin ?? 0,
      seconds: 0,
      milliseconds: 0,
    });
    const end = set(base, {
      hours: fields.endHour ?? fields.startHour + 1,
      minutes: fields.endMin ?? fields.startMin ?? 0,
      seconds: 0,
      milliseconds: 0,
    });

    const auth = await authenticateGoogle();
    const result = await runCommand(auth, "CREATE_EVENT", {
      summary: fields.summary,
      start: start.toISOString(),
      end: end.toISOString(),
      attendees: normalizeEmails(fields.attendees),
      description: fields.description || "Criado pelo Amana_BOT",
    });

    await endTask(chatId);
    return `📅 Reunião criada: “${result.summary}” em ${new Date(
      result.start.dateTime || result.start
    ).toLocaleString()} até ${new Date(
      result.end.dateTime || result.end
    ).toLocaleString()}.`;
  } catch (err) {
    return `❌ Não consegui criar o evento: ${err.message}. Quer tentar novamente sem convidados?`;
  }
}

// ======== fluxo: leitura de e-mails (mantido simplificado) ===============

export async function handleReadEmails(chatId, text) {
  const { intent, fields, stage } = await getDialogState(chatId);
  let reply = "";
  let nextStage = stage;
  const newFields = { ...fields };

  if (!intent || intent !== "READ_EMAILS") {
    await updateContext(chatId, { intent: "READ_EMAILS", fields: {}, stage: "awaiting_scope" });
    return "Você quer que eu leia todos os e-mails não lidos ou apenas os importantes?";
  } else if (stage === "awaiting_scope") {
    newFields.query = /importantes/i.test(text) ? "label:important" : "is:unread";
    nextStage = "awaiting_quantity";
    reply = "Perfeito. Quantos e-mails você quer que eu leia?";
  } else if (stage === "awaiting_quantity") {
    const num = parseInt(text.match(/\d+/)?.[0] || "3");
    const auth = await authenticateGoogle();
    const result = await runCommand(auth, "READ_EMAILS", { maxResults: num, query: newFields.query });
    if (!result.emails?.length) reply = "Nenhum e-mail encontrado 📭";
    else reply = "📬 Aqui estão:\n\n" + result.emails.map((e) => `• ${e.subject} – _${e.from}_`).join("\n");
    await endTask(chatId);
    nextStage = null;
  } else {
    reply = "Quer recomeçar a leitura de e-mails?";
    await endTask(chatId);
    nextStage = null;
  }

  await updateContext(chatId, { intent: "READ_EMAILS", fields: newFields, stage: nextStage });
  return reply;
}
