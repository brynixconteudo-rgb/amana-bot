// apps/amana/dialogFlows.js
// Motor de diálogo guiado do Amana_BOT
// Baseado em memória persistente (memory.js)
// Cada fluxo é dividido em estágios: identifica intenção, coleta campos, confirma e executa.

import { updateContext, getDialogState, beginTask, endTask } from "./memory.js";
import { authenticateGoogle, runCommand } from "./google.js";

// ==================== FLUXO: CRIAR EVENTO ==================== //
export async function handleCreateEvent(chatId, userText) {
  const { intent, fields, stage } = await getDialogState(chatId);
  let reply = "";
  let nextStage = stage;
  const newFields = { ...fields };

  // --- 1️⃣ Início do fluxo ---
  if (!intent || intent !== "CREATE_EVENT") {
    await beginTask(chatId, "CREATE_EVENT", {});
    reply = "Claro, vamos agendar sua reunião. Qual o título ou assunto do evento?";
    nextStage = "awaiting_summary";
  }

  // --- 2️⃣ Coleta do título ---
  else if (stage === "awaiting_summary") {
    newFields.summary = userText;
    reply = "Perfeito. Qual dia e horário da reunião?";
    nextStage = "awaiting_time";
  }

  // --- 3️⃣ Coleta de horário ---
  else if (stage === "awaiting_time") {
    const lower = userText.toLowerCase();
    const now = new Date();
    let start, end;

    if (lower.includes("amanhã")) {
      start = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    } else {
      start = now;
    }

    // heurística simples: se mencionar “às 16” ou “das 16 às 17”
    const match = lower.match(/(\d{1,2})h.*?(\d{1,2})h/);
    if (match) {
      const [_, h1, h2] = match;
      start.setHours(parseInt(h1), 0, 0);
      end = new Date(start);
      end.setHours(parseInt(h2), 0, 0);
    } else {
      start.setHours(9, 0, 0);
      end = new Date(start);
      end.setHours(10, 0, 0);
    }

    newFields.start = start.toISOString();
    newFields.end = end.toISOString();
    reply = "Entendido. Quem deve participar dessa reunião? (pode dizer nomes ou e-mails)";
    nextStage = "awaiting_attendees";
  }

  // --- 4️⃣ Coleta de participantes ---
  else if (stage === "awaiting_attendees") {
    const emails = userText
      .split(/[\s,;]+/)
      .filter((x) => x.includes("@"))
      .map((x) => x.trim());

    if (emails.length > 0) {
      newFields.attendees = emails;
      reply = "Ótimo. Deseja adicionar uma descrição ou posso criar o evento agora?";
      nextStage = "awaiting_description";
    } else {
      reply = "Não encontrei e-mails válidos. Pode repetir os endereços?";
      nextStage = "awaiting_attendees";
    }
  }

  // --- 5️⃣ Coleta de descrição ou execução ---
  else if (stage === "awaiting_description") {
    if (userText.toLowerCase().includes("crie") || userText.toLowerCase().includes("pode")) {
      reply = "Tudo certo! Criando o evento agora…";
      nextStage = "creating_event";
    } else {
      newFields.description = userText;
      reply = "Perfeito! Posso criar o evento agora?";
      nextStage = "confirm_create";
    }
  }

  // --- 6️⃣ Confirmação final e execução ---
  else if (stage === "confirm_create" || stage === "creating_event") {
    const auth = await authenticateGoogle();
    await runCommand(auth, "CREATE_EVENT", newFields);
    reply = `📅 Evento criado com sucesso: *${newFields.summary}*`;
    await endTask(chatId);
    nextStage = null;
  }

  // --- fallback ---
  else {
    reply = "Hmm, parece que já tínhamos começado algo, mas não entendi bem. Quer recomeçar o agendamento?";
    await endTask(chatId);
    nextStage = null;
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
    reply = "Claro. Você quer que eu leia todos os e-mails não lidos, ou apenas os mais importantes?";
    nextStage = "awaiting_scope";
  } else if (stage === "awaiting_scope") {
    if (userText.toLowerCase().includes("importantes")) {
      newFields.query = "label:important";
      reply = "Perfeito. Quantos e-mails você quer que eu leia?";
      nextStage = "awaiting_quantity";
    } else {
      newFields.query = "is:unread";
      reply = "Ok. Quantos e-mails devo ler?";
      nextStage = "awaiting_quantity";
    }
  } else if (stage === "awaiting_quantity") {
    const num = parseInt(userText.match(/\d+/)?.[0] || "1");
    const auth = await authenticateGoogle();
    const result = await runCommand(auth, "READ_EMAILS", { maxResults: num, query: newFields.query });
    if (!result.emails || result.emails.length === 0) {
      reply = "Nenhum e-mail encontrado 📭";
    } else {
      reply = "📬 Aqui estão:\n\n" + result.emails.map((e) => `• ${e.subject} – _${e.from}_`).join("\n");
    }
    await endTask(chatId);
    nextStage = null;
  } else {
    reply = "Podemos recomeçar a leitura dos e-mails?";
    await endTask(chatId);
    nextStage = null;
  }

  await updateContext(chatId, { intent: "READ_EMAILS", fields: newFields, stage: nextStage });
  return reply;
}
