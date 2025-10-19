// apps/amana/dialogFlows.js
// Motor de diálogo guiado: CREATE_EVENT e READ_EMAILS

import { updateContext, getDialogState, beginTask, endTask } from "./memory.js";
import { authenticateGoogle, runCommand } from "./google.js";

const TZ = "America/Sao_Paulo";

// Util: parseia datas/horas simples em pt-BR
function parseTimeRangePT(text) {
  const t = (text || "").toLowerCase();
  const now = new Date();
  let base = new Date(now);
  if (/amanh(ã|a)/.test(t)) base = new Date(now.getTime() + 24 * 60 * 60 * 1000);

  // das 16h às 17h | às 16h até 17h | 16 às 18 | 16h a 18h
  const m = t.match(/(?:das?|às?)\s*(\d{1,2})(?::?(\d{2}))?\s*h?\s*(?:a(té|s)?|às?)\s*(\d{1,2})(?::?(\d{2}))?\s*h?/);
  const m2 = t.match(/(\d{1,2})\s*h?\s*(?:a(té|s)?|às?)\s*(\d{1,2})\s*h?/);

  let sh = null, sm = 0, eh = null, em = 0;
  if (m) { sh = Number(m[1]); sm = Number(m[2] || 0); eh = Number(m[4]); em = Number(m[5] || 0); }
  else if (m2) { sh = Number(m2[1]); eh = Number(m2[3]); sm = 0; em = 0; }

  if (sh == null || eh == null) return null;

  const start = new Date(base); start.setHours(sh, sm, 0, 0);
  const end = new Date(base);   end.setHours(eh, em, 0, 0);
  return { start: start.toISOString(), end: end.toISOString() };
}

function extractEmails(text) {
  const raw = (text || "").split(/[\s,;]+/).map((s) => s.trim());
  const emails = raw.filter((v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v));
  if (/apenas\s*eu|só\s*eu|sem\s*convidados/.test((text || "").toLowerCase())) return [];
  return emails;
}

// ==================== FLUXO: CRIAR EVENTO ==================== //
export async function handleCreateEvent(chatId, userText) {
  const { intent, fields, stage } = await getDialogState(chatId);
  let reply = "";
  let nextStage = stage;
  const newFields = { ...fields };

  if (!intent || intent !== "CREATE_EVENT") {
    // inicia fluxo e tenta extrair dados já da primeira fala
    await beginTask(chatId, "CREATE_EVENT", {});
    const tr = parseTimeRangePT(userText);
    if (tr) { newFields.start = tr.start; newFields.end = tr.end; }
    const em = extractEmails(userText); if (em.length >= 0) newFields.attendees = em; // [] = só você
    if (!newFields.summary) {
      reply = "Vamos agendar sua reunião. Qual o título do evento?";
      nextStage = "awaiting_summary";
    } else {
      reply = "Qual o dia e horário?";
      nextStage = "awaiting_time";
    }
  }
  else if (stage === "awaiting_summary") {
    newFields.summary = userText;
    // se já não tiver horário, pergunta
    if (!newFields.start || !newFields.end) {
      reply = "Qual dia e horário da reunião?";
      nextStage = "awaiting_time";
    } else {
      reply = "Quem deve participar? (pode dizer nomes ou e-mails; diga 'apenas eu' para sem convidados)";
      nextStage = "awaiting_attendees";
    }
  }
  else if (stage === "awaiting_time") {
    const tr = parseTimeRangePT(userText);
    if (!tr) {
      reply = "Não entendi o horário. Pode dizer, por exemplo, 'hoje das 16h às 17h' ou 'amanhã às 10h até 11h'?";
      nextStage = "awaiting_time";
    } else {
      newFields.start = tr.start; newFields.end = tr.end;
      reply = "Quem deve participar? (ou diga 'apenas eu')";
      nextStage = "awaiting_attendees";
    }
  }
  else if (stage === "awaiting_attendees") {
    const em = extractEmails(userText);
    if (em.length === 0 && !/apenas\s*eu|só\s*eu|sem\s*convidados/.test(userText.toLowerCase())) {
      reply = "Não encontrei e-mails válidos. Pode repetir ou dizer 'apenas eu'?";
      nextStage = "awaiting_attendees";
    } else {
      newFields.attendees = em; // [] → sem convidados
      reply = "Quer adicionar uma descrição? Se não, diga 'pode criar'.";
      nextStage = "awaiting_description";
    }
  }
  else if (stage === "awaiting_description") {
    const ok = /(pode\s*criar|crie|pode\s*marcar|confirmo|ok|sim)/i.test(userText);
    if (ok) {
      reply = "Criando o evento…";
      nextStage = "creating_event";
    } else {
      newFields.description = userText;
      reply = "Perfeito! Posso criar o evento agora?";
      nextStage = "confirm_create";
    }
  }
  else if (stage === "confirm_create" || stage === "creating_event") {
    // valida mínimos
    if (!newFields.summary) { reply = "Preciso do título do evento."; nextStage = "awaiting_summary"; }
    else if (!newFields.start || !newFields.end) { reply = "Preciso do dia e do horário."; nextStage = "awaiting_time"; }
    else {
      const auth = await authenticateGoogle();
      await runCommand(auth, "CREATE_EVENT", newFields);
      reply = `📅 Evento criado: *${newFields.summary}*`;
      await endTask(chatId);
      nextStage = null;
    }
  }
  else {
    reply = "Vamos recomeçar o agendamento? Diga o título do evento.";
    await beginTask(chatId, "CREATE_EVENT", {});
    nextStage = "awaiting_summary";
  }

  await updateContext(chatId, { intent: "CREATE_EVENT", fields: newFields, stage: nextStage });
  return reply;
}

// ==================== FLUXO: LER EMAILS ==================== //
export async function handleReadEmails(chatId, userText) {
  const { intent, fields, stage } = await getDialogState(chatId);
  let reply = "";
  let nextStage = stage;
  const newFields = { ...fields };

  if (!intent || intent !== "READ_EMAILS") {
    await beginTask(chatId, "READ_EMAILS", {});
    reply = "Você quer os e-mails *não lidos* ou os *importantes*?";
    nextStage = "awaiting_scope";
  }
  else if (stage === "awaiting_scope") {
    if (/importantes?/i.test(userText)) {
      newFields.query = "label:important";
      reply = "Quantos e-mails devo ler?";
      nextStage = "awaiting_quantity";
    } else {
      newFields.query = "is:unread";
      reply = "Quantos e-mails devo ler?";
      nextStage = "awaiting_quantity";
    }
  }
  else if (stage === "awaiting_quantity") {
    const num = parseInt(userText.match(/\d+/)?.[0] || "1", 10);
    const auth = await authenticateGoogle();
    const result = await runCommand(auth, "READ_EMAILS", { maxResults: Math.max(1, num), query: newFields.query });
    if (!result.emails?.length) reply = "Nenhum e-mail encontrado 📭";
    else reply = "📬 " + result.emails.map((e) => `• ${e.subject || "(sem assunto)"} — _${e.from || ""}_`).join("\n");
    await endTask(chatId);
    nextStage = null;
  }
  else {
    reply = "Quer recomeçar a leitura dos e-mails?";
    await endTask(chatId);
    nextStage = null;
  }

  await updateContext(chatId, { intent: "READ_EMAILS", fields: newFields, stage: nextStage });
  return reply;
}

// ==================== ROTEADOR ==================== //
export async function routeDialog(chatId, userText) {
  const { intent } = await getDialogState(chatId);
  const t = (userText || "").toLowerCase();

  // Se já há fluxo em andamento
  if (intent === "CREATE_EVENT") return await handleCreateEvent(chatId, userText);
  if (intent === "READ_EMAILS")  return await handleReadEmails(chatId, userText);

  // Detecta nova intenção
  if (/(reuni|evento|agend|marc)/i.test(t)) return await handleCreateEvent(chatId, userText);
  if (/(email|e-mail)/i.test(t) && /(ler|leia|mostrar|trazer)/i.test(t)) return await handleReadEmails(chatId, userText);

  // sem fluxo
  return null;
}
