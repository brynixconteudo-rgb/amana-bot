// apps/amana/dialogFlows.js
// 🌐 Motor de diálogo do Amana_BOT
// Controla fluxos de conversa baseados em contexto e memória persistente (memory.js)
// Compatível com autenticação OAuth (não usa Service Account)

import { updateContext, getDialogState, beginTask, endTask } from "./memory.js";
import { authenticateGoogle, runCommand } from "./google.js";

// ============================================================
// 🗓️ FLUXO: CRIAR EVENTO
// ============================================================
export async function handleCreateEvent(chatId, userText) {
  const { intent, fields, stage } = await getDialogState(chatId);
  let reply = "";
  let nextStage = stage;
  const newFields = { ...fields };

  // 1️⃣ Início
  if (!intent || intent !== "CREATE_EVENT") {
    await beginTask(chatId, "CREATE_EVENT", {});
    reply = "Certo, vamos agendar uma reunião. Qual o título do evento?";
    nextStage = "awaiting_summary";
  }

  // 2️⃣ Título
  else if (stage === "awaiting_summary") {
    newFields.summary = userText;
    reply = "Perfeito. Qual dia e horário da reunião?";
    nextStage = "awaiting_time";
  }

  // 3️⃣ Data e horário
  else if (stage === "awaiting_time") {
    const lower = userText.toLowerCase();
    const now = new Date();
    let start, end;

    if (lower.includes("amanhã")) {
      start = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    } else {
      start = now;
    }

    // Detecta “das 16h às 18h”
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
    reply = "Entendido. Quem deve participar? (pode dizer nomes ou e-mails)";
    nextStage = "awaiting_attendees";
  }

  // 4️⃣ Participantes
  else if (stage === "awaiting_attendees") {
    const emails = userText
      .split(/[\s,;]+/)
      .filter((x) => x.includes("@"))
      .map((x) => x.trim());

    if (emails.length > 0) {
      newFields.attendees = emails;
      reply = "Quer adicionar uma descrição ou posso criar o evento agora?";
      nextStage = "awaiting_description";
    } else if (userText.toLowerCase().includes("sem convidados")) {
      newFields.attendees = [];
      reply = "Ok, sem convidados. Deseja adicionar uma descrição ou posso criar o evento agora?";
      nextStage = "awaiting_description";
    } else {
      reply = "Não encontrei e-mails válidos. Pode repetir os endereços?";
      nextStage = "awaiting_attendees";
    }
  }

  // 5️⃣ Descrição
  else if (stage === "awaiting_description") {
    if (userText.toLowerCase().includes("crie") || userText.toLowerCase().includes("pode")) {
      reply = "Tudo certo! Criando o evento...";
      nextStage = "creating_event";
    } else {
      newFields.description = userText;
      reply = "Perfeito! Posso criar o evento agora?";
      nextStage = "confirm_create";
    }
  }

  // 6️⃣ Criação
  else if (stage === "confirm_create" || stage === "creating_event") {
    try {
      const auth = await authenticateGoogle();
      await runCommand(auth, "CREATE_EVENT", newFields);
      reply = `📅 Evento criado com sucesso: *${newFields.summary}*`;
    } catch (err) {
      reply = `❌ Erro ao criar o evento: ${err.message}`;
    }
    await endTask(chatId);
    nextStage = null;
  }

  // 🧩 Fallback
  else {
    reply = "Parece que já tínhamos começado algo, mas não entendi bem. Quer recomeçar o agendamento?";
    await endTask(chatId);
    nextStage = null;
  }

  await updateContext(chatId, { intent: "CREATE_EVENT", fields: newFields, stage: nextStage });
  return reply;
}

// ============================================================
// 📬 FLUXO: LER EMAILS
// ============================================================
export async function handleReadEmails(chatId, userText) {
  const { intent, fields, stage } = await getDialogState(chatId);
  let reply = "";
  let nextStage = stage;
  const newFields = { ...fields };

  // 1️⃣ Início
  if (!intent || intent !== "READ_EMAILS") {
    await beginTask(chatId, "READ_EMAILS", {});
    reply = "Quer que eu leia todos os e-mails não lidos ou apenas os mais importantes?";
    nextStage = "awaiting_scope";
  }

  // 2️⃣ Escopo
  else if (stage === "awaiting_scope") {
    if (userText.toLowerCase().includes("importantes")) {
      newFields.query = "label:important";
      reply = "Perfeito. Quantos e-mails você quer que eu leia?";
      nextStage = "awaiting_quantity";
    } else {
      newFields.query = "is:unread";
      reply = "Ok. Quantos e-mails devo ler?";
      nextStage = "awaiting_quantity";
    }
  }

  // 3️⃣ Quantidade
  else if (stage === "awaiting_quantity") {
    const num = parseInt(userText.match(/\d+/)?.[0] || "3", 10);
    const auth = await authenticateGoogle();
    const result = await runCommand(auth, "READ_EMAILS", { maxResults: num, query: newFields.query });

    if (!result.emails || result.emails.length === 0) {
      reply = "Nenhum e-mail encontrado 📭";
      await endTask(chatId);
      nextStage = null;
    } else {
      newFields.emails = result.emails;
      newFields.index = 0;
      const first = result.emails[0];
      reply = `📧 *${first.subject}*\n_De ${first.from}_\n\nQuer que eu continue lendo? (sim/não)`;
      nextStage = "awaiting_continue";
    }
  }

  // 4️⃣ Continua lendo?
  else if (stage === "awaiting_continue") {
    const answer = userText.toLowerCase();

    if (answer.includes("sim")) {
      const nextIndex = (newFields.index || 0) + 1;
      if (nextIndex < (newFields.emails?.length || 0)) {
        const email = newFields.emails[nextIndex];
        newFields.index = nextIndex;
        reply = `📧 *${email.subject}*\n_De ${email.from}_\n\nQuer continuar lendo? (sim/não)`;
        nextStage = "awaiting_continue";
      } else {
        reply = "Fim da lista de e-mails 📪";
        await endTask(chatId);
        nextStage = null;
      }
    } else if (answer.includes("não")) {
      reply = "Tudo bem 👍 Parando a leitura.";
      await endTask(chatId);
      nextStage = null;
    } else {
      reply = "Não entendi. Deseja continuar lendo os próximos e-mails? (sim/não)";
      nextStage = "awaiting_continue";
    }
  }

  // 🧩 Fallback
  else {
    reply = "Vamos recomeçar a leitura dos e-mails?";
    await endTask(chatId);
    nextStage = null;
  }

  await updateContext(chatId, { intent: "READ_EMAILS", fields: newFields, stage: nextStage });
  return reply;
}

// ============================================================
// ✉️ FLUXO: ENVIAR EMAIL
// ============================================================
export async function handleSendEmail(chatId, userText) {
  const { intent, fields, stage } = await getDialogState(chatId);
  let reply = "";
  let nextStage = stage;
  const newFields = { ...fields };

  if (!intent || intent !== "SEND_EMAIL") {
    await beginTask(chatId, "SEND_EMAIL", {});
    reply = "Claro, para quem devo enviar o e-mail?";
    nextStage = "awaiting_to";
  }

  else if (stage === "awaiting_to") {
    const emails = userText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-z]{2,}/g);
    if (emails && emails.length > 0) {
      newFields.to = emails;
      reply = "Qual será o assunto?";
      nextStage = "awaiting_subject";
    } else {
      reply = "Não encontrei e-mails válidos. Pode repetir o destinatário?";
      nextStage = "awaiting_to";
    }
  }

  else if (stage === "awaiting_subject") {
    newFields.subject = userText;
    reply = "E qual será o conteúdo da mensagem?";
    nextStage = "awaiting_body";
  }

  else if (stage === "awaiting_body") {
    newFields.body = userText;
    reply = "Posso enviar agora?";
    nextStage = "confirm_send";
  }

  else if (stage === "confirm_send") {
    if (userText.toLowerCase().includes("sim")) {
      try {
        const auth = await authenticateGoogle();
        await runCommand(auth, "SEND_EMAIL", newFields);
        reply = `📤 E-mail enviado com sucesso para ${newFields.to.join(", ")}`;
      } catch (err) {
        reply = `❌ Erro ao enviar o e-mail: ${err.message}`;
      }
      await endTask(chatId);
      nextStage = null;
    } else {
      reply = "Tudo bem 👍 E-mail cancelado.";
      await endTask(chatId);
      nextStage = null;
    }
  }

  else {
    reply = "Quer tentar enviar um novo e-mail?";
    await endTask(chatId);
    nextStage = null;
  }

  await updateContext(chatId, { intent: "SEND_EMAIL", fields: newFields, stage: nextStage });
  return reply;
}

// ============================================================
// 💾 FLUXO: SALVAR MEMÓRIA
// ============================================================
export async function handleSaveMemory(chatId, userText) {
  const { intent, fields, stage } = await getDialogState(chatId);
  let reply = "";
  let nextStage = stage;
  const newFields = { ...fields };

  if (!intent || intent !== "SAVE_MEMORY") {
    await beginTask(chatId, "SAVE_MEMORY", {});
    reply = "Quer salvar essa memória com algum título?";
    nextStage = "awaiting_title";
  }

  else if (stage === "awaiting_title") {
    newFields.title = userText;
    reply = "Perfeito. Qual é o conteúdo que devo registrar?";
    nextStage = "awaiting_content";
  }

  else if (stage === "awaiting_content") {
    newFields.content = userText;
    try {
      const auth = await authenticateGoogle();
      await runCommand(auth, "SAVE_MEMORY", newFields);
      reply = `🧠 Memória salva com o título: *${newFields.title}*`;
    } catch (err) {
      reply = `❌ Erro ao salvar memória: ${err.message}`;
    }
    await endTask(chatId);
    nextStage = null;
  }

  else {
    reply = "Quer registrar outra memória?";
    await endTask(chatId);
    nextStage = null;
  }

  await updateContext(chatId, { intent: "SAVE_MEMORY", fields: newFields, stage: nextStage });
  return reply;
}
