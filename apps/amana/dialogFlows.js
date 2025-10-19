// apps/amana/dialogFlows.js
// 🌐 Motor de diálogo completo e persistente do Amana_BOT
// Suporte a OAuth + integração com IA semântica (ai.js)

import { updateContext, getDialogState, beginTask, endTask } from "./memory.js";
import { authenticateGoogle, runCommand } from "./google.js";

// ============================================================
// 🗓️ CRIAR EVENTO
// ============================================================
export async function handleCreateEvent(chatId, userText, entities = {}) {
  const state = await getDialogState(chatId);
  const intent = "CREATE_EVENT";
  const fields = { ...state.fields, ...entities };
  const stage = state.stage || "start";
  let reply = "";
  let nextStage = stage;

  if (stage === "start") {
    await beginTask(chatId, intent, fields);
    if (fields.summary && fields.start && fields.end) {
      reply = `Criando evento '${fields.summary}' para o horário especificado...`;
      nextStage = "creating_event";
    } else {
      reply = "Certo, vamos agendar uma reunião. Qual o título do evento?";
      nextStage = "awaiting_summary";
    }
  } 
  else if (stage === "awaiting_summary") {
    fields.summary = userText;
    reply = "Perfeito. Qual dia e horário da reunião?";
    nextStage = "awaiting_time";
  } 
  else if (stage === "awaiting_time") {
    const lower = userText.toLowerCase();
    const now = new Date();
    let start = new Date(now);
    let end = new Date(now);

    if (lower.includes("amanhã")) start.setDate(now.getDate() + 1);
    const match = lower.match(/(\d{1,2})h.*?(\d{1,2})h/);
    if (match) {
      start.setHours(parseInt(match[1]), 0, 0);
      end.setHours(parseInt(match[2]), 0, 0);
    } else {
      start.setHours(9, 0, 0);
      end.setHours(10, 0, 0);
    }

    fields.start = start.toISOString();
    fields.end = end.toISOString();
    reply = "Entendido. Quem deve participar? (pode dizer nomes ou e-mails)";
    nextStage = "awaiting_attendees";
  } 
  else if (stage === "awaiting_attendees") {
    const emails = userText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-z]{2,}/g);
    if (emails) {
      fields.attendees = emails;
      reply = "Quer adicionar uma descrição ou posso criar o evento agora?";
      nextStage = "awaiting_description";
    } else if (userText.toLowerCase().includes("sem convidados")) {
      fields.attendees = [];
      reply = "Ok, sem convidados. Deseja adicionar uma descrição ou posso criar o evento agora?";
      nextStage = "awaiting_description";
    } else {
      reply = "Não encontrei e-mails válidos. Pode repetir os endereços?";
      nextStage = "awaiting_attendees";
    }
  } 
  else if (stage === "awaiting_description") {
    if (userText.toLowerCase().includes("crie") || userText.toLowerCase().includes("pode")) {
      reply = "Tudo certo! Criando o evento...";
      nextStage = "creating_event";
    } else {
      fields.description = userText;
      reply = "Perfeito! Posso criar o evento agora?";
      nextStage = "confirm_create";
    }
  } 
  else if (stage === "confirm_create" || stage === "creating_event") {
    try {
      const auth = await authenticateGoogle();
      await runCommand(auth, "CREATE_EVENT", fields);
      reply = `📅 Evento criado com sucesso: *${fields.summary}*`;
    } catch (err) {
      reply = `❌ Erro ao criar o evento: ${err.message}`;
    }
    await endTask(chatId);
    nextStage = null;
  } 
  else {
    reply = "Vamos recomeçar o agendamento?";
    await endTask(chatId);
    nextStage = null;
  }

  await updateContext(chatId, { intent, fields, stage: nextStage });
  return reply;
}

// ============================================================
// 📬 LER EMAILS
// ============================================================
export async function handleReadEmails(chatId, userText, entities = {}) {
  const state = await getDialogState(chatId);
  const intent = "READ_EMAILS";
  const fields = { ...state.fields, ...entities };
  const stage = state.stage || "start";
  let reply = "";
  let nextStage = stage;

  if (stage === "start") {
    await beginTask(chatId, intent, {});
    reply = "Quer que eu leia e-mails não lidos ou apenas os importantes?";
    nextStage = "awaiting_scope";
  } 
  else if (stage === "awaiting_scope") {
    fields.query = userText.toLowerCase().includes("importantes")
      ? "label:important"
      : "is:unread";
    reply = "Quantos e-mails devo ler?";
    nextStage = "awaiting_quantity";
  } 
  else if (stage === "awaiting_quantity") {
    const num = parseInt(userText.match(/\d+/)?.[0] || "3");
    const auth = await authenticateGoogle();
    const result = await runCommand(auth, "READ_EMAILS", { maxResults: num, query: fields.query });

    if (!result.emails || result.emails.length === 0) {
      reply = "Nenhum e-mail encontrado 📭";
      await endTask(chatId);
      nextStage = null;
    } else {
      fields.emails = result.emails;
      fields.index = 0;
      const first = result.emails[0];
      reply = `📧 *${first.subject}*\n_De ${first.from}_\n\nQuer que eu continue lendo? (sim/não)`;
      nextStage = "awaiting_continue";
    }
  } 
  else if (stage === "awaiting_continue") {
    const answer = userText.toLowerCase();
    if (answer.includes("sim")) {
      const nextIndex = (fields.index || 0) + 1;
      if (nextIndex < fields.emails.length) {
        const email = fields.emails[nextIndex];
        fields.index = nextIndex;
        reply = `📧 *${email.subject}*\n_De ${email.from}_\n\nQuer continuar lendo? (sim/não)`;
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
      reply = "Não entendi. Deseja continuar lendo? (sim/não)";
    }
  } 
  else {
    reply = "Quer recomeçar a leitura dos e-mails?";
    await endTask(chatId);
    nextStage = null;
  }

  await updateContext(chatId, { intent, fields, stage: nextStage });
  return reply;
}

// ============================================================
// ✉️ ENVIAR EMAIL
// ============================================================
export async function handleSendEmail(chatId, userText, entities = {}) {
  const state = await getDialogState(chatId);
  const intent = "SEND_EMAIL";
  const fields = { ...state.fields, ...entities };
  const stage = state.stage || "start";
  let reply = "";
  let nextStage = stage;

  if (stage === "start") {
    await beginTask(chatId, intent, {});
    reply = "Para quem devo enviar o e-mail?";
    nextStage = "awaiting_to";
  } 
  else if (stage === "awaiting_to") {
    const emails = userText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-z]{2,}/g);
    if (emails && emails.length > 0) {
      fields.to = emails;
      reply = "Qual será o assunto?";
      nextStage = "awaiting_subject";
    } else {
      reply = "Não encontrei e-mails válidos. Pode repetir o destinatário?";
      nextStage = "awaiting_to";
    }
  } 
  else if (stage === "awaiting_subject") {
    fields.subject = userText;
    reply = "Qual é o conteúdo da mensagem?";
    nextStage = "awaiting_body";
  } 
  else if (stage === "awaiting_body") {
    fields.body = userText;
    reply = "Posso enviar agora?";
    nextStage = "confirm_send";
  } 
  else if (stage === "confirm_send") {
    if (userText.toLowerCase().includes("sim")) {
      try {
        const auth = await authenticateGoogle();
        await runCommand(auth, "SEND_EMAIL", fields);
        reply = `📤 E-mail enviado com sucesso para ${fields.to.join(", ")}`;
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

  await updateContext(chatId, { intent, fields, stage: nextStage });
  return reply;
}

// ============================================================
// 💾 SALVAR MEMÓRIA
// ============================================================
export async function handleSaveMemory(chatId, userText, entities = {}) {
  const state = await getDialogState(chatId);
  const intent = "SAVE_MEMORY";
  const fields = { ...state.fields, ...entities };
  const stage = state.stage || "start";
  let reply = "";
  let nextStage = stage;

  if (stage === "start") {
    await beginTask(chatId, intent, {});
    reply = "Quer salvar essa memória com algum título?";
    nextStage = "awaiting_title";
  } 
  else if (stage === "awaiting_title") {
    fields.title = userText;
    reply = "Qual é o conteúdo que devo registrar?";
    nextStage = "awaiting_content";
  } 
  else if (stage === "awaiting_content") {
    fields.content = userText;
    try {
      const auth = await authenticateGoogle();
      await runCommand(auth, "SAVE_MEMORY", fields);
      reply = `🧠 Memória salva com o título: *${fields.title}*`;
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

  await updateContext(chatId, { intent, fields, stage: nextStage });
  return reply;
}

// ============================================================
// 🧭 ROTEADOR SEMÂNTICO (usa análise do ai.js)
// ============================================================
export async function routeDialog(chatId, userText, intent = null, entities = {}) {
  if (!intent) intent = "UNKNOWN";

  switch (intent) {
    case "CREATE_EVENT":
      return await handleCreateEvent(chatId, userText, entities);
    case "READ_EMAILS":
      return await handleReadEmails(chatId, userText, entities);
    case "SEND_EMAIL":
      return await handleSendEmail(chatId, userText, entities);
    case "SAVE_MEMORY":
      return await handleSaveMemory(chatId, userText, entities);
    default:
      return "Desculpe, não entendi o que deseja fazer. Você pode pedir, por exemplo:\n- 'Agende uma reunião'\n- 'Leia meus e-mails'\n- 'Envie um e-mail'\n- 'Salve uma memória'";
  }
}
