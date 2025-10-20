// apps/amana/dialogFlows.js
// 🌐 Motor de diálogo persistente do Amana_BOT — v3 com logs e fluxos expandidos

import { updateContext, getDialogState, beginTask, endTask } from "./memory.js";
import { authenticateGoogle, runCommand } from "./google.js";

/* ============================================================
   🧭 Função auxiliar de logging e contexto
============================================================ */
function log(label, data) {
  console.log(`[${label}]`, typeof data === "object" ? JSON.stringify(data) : data);
}

/* ============================================================
   🧹 Função para resetar o estado
============================================================ */
async function resetContext(chatId, reply = "Ok, vamos começar de novo.") {
  log("STATE", `Resetando contexto do chat ${chatId}`);
  await endTask(chatId);
  await updateContext(chatId, { intent: null, fields: {}, stage: null });
  return reply;
}

/* ============================================================
   🗓️ CRIAR EVENTO
============================================================ */
async function handleCreateEvent(chatId, userText) {
  const state = await getDialogState(chatId);
  const intent = "CREATE_EVENT";
  const fields = state.fields || {};
  const stage = state.stage || "start";
  let reply = "";
  let nextStage = stage;
  const newFields = { ...fields };
  log("FLOW", `CREATE_EVENT:${stage}`);

  try {
    if (stage === "start") {
      await beginTask(chatId, intent, {});
      reply = "Certo, vamos agendar uma reunião. Qual o título do evento?";
      nextStage = "awaiting_summary";
    } else if (stage === "awaiting_summary") {
      newFields.summary = userText;
      reply = "Perfeito. Qual dia e horário da reunião?";
      nextStage = "awaiting_time";
    } else if (stage === "awaiting_time") {
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
      newFields.start = start.toISOString();
      newFields.end = end.toISOString();
      reply = "Entendido. Quem deve participar? (pode dizer nomes ou e-mails)";
      nextStage = "awaiting_attendees";
    } else if (stage === "awaiting_attendees") {
      const emails = userText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-z]{2,}/g);
      newFields.attendees = emails || [];
      reply = "Quer adicionar uma descrição ou posso criar o evento agora?";
      nextStage = "awaiting_description";
    } else if (stage === "awaiting_description") {
      if (userText.toLowerCase().includes("crie") || userText.toLowerCase().includes("pode")) {
        reply = "Tudo certo! Criando o evento...";
        nextStage = "creating_event";
      } else {
        newFields.description = userText;
        reply = "Perfeito! Posso criar o evento agora?";
        nextStage = "confirm_create";
      }
    } else if (stage === "confirm_create" || stage === "creating_event") {
      const auth = await authenticateGoogle();
      await runCommand(auth, "CREATE_EVENT", newFields);
      reply = `📅 Evento criado com sucesso: *${newFields.summary}*`;
      await endTask(chatId);
      nextStage = null;
    }
  } catch (err) {
    reply = `❌ Erro ao criar o evento: ${err.message}`;
    await endTask(chatId);
    nextStage = null;
  }

  await updateContext(chatId, { intent, fields: newFields, stage: nextStage });
  return reply;
}

/* ============================================================
   📬 LER EMAILS
============================================================ */
async function handleReadEmails(chatId, userText) {
  const state = await getDialogState(chatId);
  const intent = "READ_EMAILS";
  const fields = state.fields || {};
  const stage = state.stage || "start";
  let reply = "";
  let nextStage = stage;
  const newFields = { ...fields };
  log("FLOW", `READ_EMAILS:${stage}`);

  try {
    if (stage === "start") {
      await beginTask(chatId, intent, {});
      reply = "Quer que eu leia e-mails não lidos ou apenas os importantes?";
      nextStage = "awaiting_scope";
    } else if (stage === "awaiting_scope") {
      newFields.query = userText.toLowerCase().includes("importantes")
        ? "label:important"
        : "is:unread";
      reply = "Quantos e-mails devo ler?";
      nextStage = "awaiting_quantity";
    } else if (stage === "awaiting_quantity") {
      const num = parseInt(userText.match(/\d+/)?.[0] || "3");
      const auth = await authenticateGoogle();
      const result = await runCommand(auth, "READ_EMAILS", {
        maxResults: num,
        query: newFields.query,
      });
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
    } else if (stage === "awaiting_continue") {
      const answer = userText.toLowerCase();
      const nextIndex = (newFields.index || 0) + 1;
      if (answer.includes("sim") && nextIndex < newFields.emails.length) {
        const email = newFields.emails[nextIndex];
        newFields.index = nextIndex;
        reply = `📧 *${email.subject}*\n_De ${email.from}_\n\nQuer continuar lendo? (sim/não)`;
      } else {
        reply = "Fim da lista de e-mails 📪";
        await endTask(chatId);
        nextStage = null;
      }
    }
  } catch (err) {
    reply = `❌ Erro ao ler e-mails: ${err.message}`;
    await endTask(chatId);
    nextStage = null;
  }

  await updateContext(chatId, { intent, fields: newFields, stage: nextStage });
  return reply;
}

/* ============================================================
   ✉️ ENVIAR EMAIL
============================================================ */
async function handleSendEmail(chatId, userText) {
  const state = await getDialogState(chatId);
  const intent = "SEND_EMAIL";
  const fields = state.fields || {};
  const stage = state.stage || "start";
  let reply = "";
  let nextStage = stage;
  const newFields = { ...fields };
  log("FLOW", `SEND_EMAIL:${stage}`);

  try {
    if (stage === "start") {
      await beginTask(chatId, intent, {});
      reply = "Para quem devo enviar o e-mail?";
      nextStage = "awaiting_to";
    } else if (stage === "awaiting_to") {
      const emails = userText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-z]{2,}/g);
      if (emails) {
        newFields.to = emails;
        reply = "Qual será o assunto?";
        nextStage = "awaiting_subject";
      } else reply = "Não encontrei e-mails válidos. Pode repetir o destinatário?";
    } else if (stage === "awaiting_subject") {
      newFields.subject = userText;
      reply = "Qual é o conteúdo da mensagem?";
      nextStage = "awaiting_body";
    } else if (stage === "awaiting_body") {
      newFields.body = userText;
      reply = "Posso enviar agora?";
      nextStage = "confirm_send";
    } else if (stage === "confirm_send") {
      if (userText.toLowerCase().includes("sim")) {
        const auth = await authenticateGoogle();
        await runCommand(auth, "SEND_EMAIL", newFields);
        reply = `📤 E-mail enviado para ${newFields.to.join(", ")}`;
        await endTask(chatId);
        nextStage = null;
      } else {
        reply = "Ok, e-mail cancelado.";
        await endTask(chatId);
        nextStage = null;
      }
    }
  } catch (err) {
    reply = `❌ Erro ao enviar e-mail: ${err.message}`;
    await endTask(chatId);
    nextStage = null;
  }

  await updateContext(chatId, { intent, fields: newFields, stage: nextStage });
  return reply;
}

/* ============================================================
   💾 SALVAR MEMÓRIA
============================================================ */
async function handleSaveMemory(chatId, userText) {
  const state = await getDialogState(chatId);
  const intent = "SAVE_MEMORY";
  const stage = state.stage || "start";
  const fields = state.fields || {};
  const newFields = { ...fields };
  let reply = "";
  let nextStage = stage;
  log("FLOW", `SAVE_MEMORY:${stage}`);

  try {
    if (stage === "start") {
      await beginTask(chatId, intent, {});
      reply = "Quer salvar essa memória com algum título?";
      nextStage = "awaiting_title";
    } else if (stage === "awaiting_title") {
      newFields.title = userText;
      reply = "Qual é o conteúdo que devo registrar?";
      nextStage = "awaiting_content";
    } else if (stage === "awaiting_content") {
      newFields.content = userText;
      const auth = await authenticateGoogle();
      await runCommand(auth, "SAVE_MEMORY", newFields);
      reply = `🧠 Memória salva com o título: *${newFields.title}*`;
      await endTask(chatId);
      nextStage = null;
    }
  } catch (err) {
    reply = `❌ Erro ao salvar memória: ${err.message}`;
    await endTask(chatId);
    nextStage = null;
  }

  await updateContext(chatId, { intent, fields: newFields, stage: nextStage });
  return reply;
}

/* ============================================================
   🗓️ MOSTRAR AGENDA
============================================================ */
async function handleShowAgenda(chatId) {
  log("FLOW", "SHOW_AGENDA:start");
  try {
    const auth = await authenticateGoogle();
    const result = await runCommand(auth, "SHOW_AGENDA", {});
    if (!result || result.length === 0) return "Sua agenda está vazia nos próximos dias 📭";
    const list = result.map(ev => `• ${ev.summary} em ${ev.start}`).join("\n");
    return `📅 Próximos eventos:\n${list}`;
  } catch (err) {
    return `❌ Erro ao obter agenda: ${err.message}`;
  }
}

/* ============================================================
   ❌ CANCELAR TAREFA
============================================================ */
async function handleCancel(chatId) {
  return await resetContext(chatId, "🚫 Ação atual cancelada. Pode pedir outra coisa!");
}

/* ============================================================
   🧭 ROTEADOR PRINCIPAL
============================================================ */
export async function routeDialog(chatId, userText) {
  const lower = userText.toLowerCase().trim();
  log("INTENT", `Entrada: ${lower}`);
  const state = await getDialogState(chatId);

  // reset manual
  if (["cancelar", "pare", "recomeçar", "resetar", "novo comando"].includes(lower))
    return await handleCancel(chatId);

  // tenta continuar fluxo ativo
  if (state.intent && state.stage)
    switch (state.intent) {
      case "CREATE_EVENT": return handleCreateEvent(chatId, userText);
      case "READ_EMAILS": return handleReadEmails(chatId, userText);
      case "SEND_EMAIL": return handleSendEmail(chatId, userText);
      case "SAVE_MEMORY": return handleSaveMemory(chatId, userText);
    }

  // identifica novas intenções
  if (lower.match(/(reuni|evento|agend)/)) return handleCreateEvent(chatId, userText);
  if (lower.match(/(ler|leia).*(e-?mail|mail)/)) return handleReadEmails(chatId, userText);
  if (lower.match(/(enviar|mande|envie).*(e-?mail|mail)/)) return handleSendEmail(chatId, userText);
  if (lower.match(/(salvar|memóri|memoria)/)) return handleSaveMemory(chatId, userText);
  if (lower.match(/(agenda|compromisso|reunião marcada)/)) return handleShowAgenda(chatId);
  if (lower.match(/(cancelar|parar|abortar)/)) return handleCancel(chatId);

  // fallback
  log("INTENT", "Nenhuma intenção reconhecida.");
  return "Desculpe, não entendi o que deseja fazer. Você pode pedir, por exemplo:\n- 'Agende uma reunião'\n- 'Leia meus e-mails'\n- 'Envie um e-mail'\n- 'Salve uma memória'\n- 'Mostre minha agenda'\n- 'Cancele o que está fazendo'";
}
