// ============================================================
// 🌐 Motor de Diálogo — Amana_BOT (versão híbrida otimizada)
// ============================================================

import { updateContext, getDialogState, beginTask, endTask } from "./memory.js";
import { authenticateGoogle, runCommand } from "./google.js";

function logFlow(tag, data = "") {
  const ts = new Date().toISOString().split("T")[1].split(".")[0];
  console.log(`[${ts}] [FLOW] ${tag}${data ? " → " + JSON.stringify(data) : ""}`);
}

// ============================================================
// 🗓️ CRIAR EVENTO
// ============================================================
async function handleCreateEvent(chatId, userText) {
  const state = await getDialogState(chatId);
  const intent = state.intent || "CREATE_EVENT";
  const fields = state.fields || {};
  const stage = state.stage || "start";
  let reply = "";
  let nextStage = stage;
  const newFields = { ...fields };

  logFlow(`CREATE_EVENT:${stage}`, { chatId, userText });

  try {
    switch (stage) {
      case "start":
        await beginTask(chatId, intent, {});
        reply = "Certo, vamos agendar uma reunião. Qual o título do evento?";
        nextStage = "awaiting_summary";
        break;

      case "awaiting_summary":
        newFields.summary = userText;
        reply = "Perfeito. Qual dia e horário da reunião?";
        nextStage = "awaiting_time";
        break;

      case "awaiting_time": {
        const lower = userText.toLowerCase();
        const now = new Date();
        let start = new Date(now);
        let end = new Date(now);

        // detecta amanhã e horário no formato “9h até 10h”
        if (lower.includes("amanhã")) start.setDate(now.getDate() + 1);
        const match = lower.match(/(\d{1,2})[:h].*?(\d{1,2})[:h]?/);
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
        break;
      }

      case "awaiting_attendees": {
        const emails = userText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-z]{2,}/g);
        if (emails) {
          newFields.attendees = emails;
          reply = "Quer adicionar uma descrição ou posso criar o evento agora?";
          nextStage = "awaiting_description";
        } else if (userText.toLowerCase().includes("sem convidados")) {
          newFields.attendees = [];
          reply = "Ok, sem convidados. Deseja adicionar uma descrição ou posso criar o evento agora?";
          nextStage = "awaiting_description";
        } else {
          reply = "Não encontrei e-mails válidos. Pode repetir os endereços?";
        }
        break;
      }

      case "awaiting_description":
        if (userText.toLowerCase().includes("crie") || userText.toLowerCase().includes("pode")) {
          reply = "Tudo certo! Criando o evento...";
          nextStage = "creating_event";
        } else {
          newFields.description = userText;
          reply = "Perfeito! Posso criar o evento agora?";
          nextStage = "confirm_create";
        }
        break;

      case "confirm_create":
      case "creating_event":
        const auth = await authenticateGoogle();
        const result = await runCommand(auth, "CREATE_EVENT", newFields);
        if (!result || !result.id)
          reply = "❌ Não consegui criar o evento no Google Calendar.";
        else reply = `📅 Evento criado com sucesso: *${newFields.summary}*`;
        await endTask(chatId);
        nextStage = null;
        break;

      default:
        reply = "Vamos recomeçar o agendamento?";
        await endTask(chatId);
        nextStage = null;
    }
  } catch (err) {
    reply = `❌ Erro ao criar evento: ${err.message}`;
    await endTask(chatId);
  }

  await updateContext(chatId, { intent, fields: newFields, stage: nextStage });
  return reply;
}

// ============================================================
// 📅 MOSTRAR AGENDA
// ============================================================
async function handleShowAgenda(chatId) {
  logFlow("SHOW_AGENDA");
  try {
    const auth = await authenticateGoogle();
    const result = await runCommand(auth, "SHOW_AGENDA", {});
    if (!result?.events?.length) return "🗓️ Nenhum compromisso encontrado para hoje.";
    const agenda = result.events
      .slice(0, 5)
      .map((ev) => `• *${ev.summary || "Sem título"}* às ${ev.startTime || "?"}`)
      .join("\n");
    return `🗓️ Seus próximos compromissos:\n${agenda}`;
  } catch (err) {
    return `❌ Erro ao acessar agenda: ${err.message}`;
  }
}

// ============================================================
// 📬 LER EMAILS
// ============================================================
async function handleReadEmails(chatId, userText) {
  const state = await getDialogState(chatId);
  const intent = state.intent || "READ_EMAILS";
  const fields = state.fields || {};
  const stage = state.stage || "start";
  let reply = "";
  let nextStage = stage;
  const newFields = { ...fields };

  logFlow(`READ_EMAILS:${stage}`, { userText });

  try {
    switch (stage) {
      case "start":
        await beginTask(chatId, intent, {});
        reply = "Quer que eu leia e-mails não lidos ou apenas os importantes?";
        nextStage = "awaiting_scope";
        break;

      case "awaiting_scope":
        newFields.query = userText.toLowerCase().includes("importantes") ? "label:important" : "is:unread";
        reply = "Quantos e-mails devo ler?";
        nextStage = "awaiting_quantity";
        break;

      case "awaiting_quantity": {
        const num = parseInt(userText.match(/\d+/)?.[0] || "3");
        const auth = await authenticateGoogle();
        const result = await runCommand(auth, "READ_EMAILS", { maxResults: num, query: newFields.query });

        if (!result.emails?.length) {
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
        break;
      }

      case "awaiting_continue": {
        const answer = userText.toLowerCase();
        if (answer.includes("sim")) {
          const nextIndex = (newFields.index || 0) + 1;
          if (nextIndex < newFields.emails.length) {
            const email = newFields.emails[nextIndex];
            newFields.index = nextIndex;
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
        } else reply = "Não entendi. Deseja continuar lendo? (sim/não)";
        break;
      }

      default:
        reply = "Quer recomeçar a leitura dos e-mails?";
        await endTask(chatId);
        nextStage = null;
    }
  } catch (err) {
    reply = `❌ Erro ao ler e-mails: ${err.message}`;
    await endTask(chatId);
  }

  await updateContext(chatId, { intent, fields: newFields, stage: nextStage });
  return reply;
}

// ============================================================
// ✉️ ENVIAR EMAIL
// ============================================================
async function handleSendEmail(chatId, userText) {
  const state = await getDialogState(chatId);
  const intent = state.intent || "SEND_EMAIL";
  const fields = state.fields || {};
  const stage = state.stage || "start";
  let reply = "";
  let nextStage = stage;
  const newFields = { ...fields };

  logFlow(`SEND_EMAIL:${stage}`, { userText });

  try {
    switch (stage) {
      case "start":
        await beginTask(chatId, intent, {});
        reply = "Para quem devo enviar o e-mail?";
        nextStage = "awaiting_to";
        break;

      case "awaiting_to": {
        const emails = userText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-z]{2,}/g);
        if (emails) {
          newFields.to = emails;
          reply = "Qual será o assunto?";
          nextStage = "awaiting_subject";
        } else {
          reply = "Não encontrei e-mails válidos. Pode repetir o destinatário?";
        }
        break;
      }

      case "awaiting_subject":
        newFields.subject = userText;
        reply = "Qual é o conteúdo da mensagem?";
        nextStage = "awaiting_body";
        break;

      case "awaiting_body":
        newFields.body = userText;
        reply = "Posso enviar agora?";
        nextStage = "confirm_send";
        break;

      case "confirm_send":
        if (userText.toLowerCase().includes("sim")) {
          const auth = await authenticateGoogle();
          await runCommand(auth, "SEND_EMAIL", newFields);
          reply = `📤 E-mail enviado para ${newFields.to.join(", ")}`;
        } else reply = "Tudo bem 👍 E-mail cancelado.";
        await endTask(chatId);
        nextStage = null;
        break;

      default:
        reply = "Quer tentar enviar um novo e-mail?";
        await endTask(chatId);
        nextStage = null;
    }
  } catch (err) {
    reply = `❌ Erro ao enviar e-mail: ${err.message}`;
    await endTask(chatId);
  }

  await updateContext(chatId, { intent, fields: newFields, stage: nextStage });
  return reply;
}

// ============================================================
// 💾 SALVAR MEMÓRIA
// ============================================================
async function handleSaveMemory(chatId, userText) {
  const state = await getDialogState(chatId);
  const intent = state.intent || "SAVE_MEMORY";
  const fields = state.fields || {};
  const stage = state.stage || "start";
  let reply = "";
  let nextStage = stage;
  const newFields = { ...fields };

  logFlow(`SAVE_MEMORY:${stage}`, { userText });

  try {
    switch (stage) {
      case "start":
        await beginTask(chatId, intent, {});
        reply = "Quer salvar essa memória com algum título?";
        nextStage = "awaiting_title";
        break;

      case "awaiting_title":
        newFields.title = userText;
        reply = "Qual é o conteúdo que devo registrar?";
        nextStage = "awaiting_content";
        break;

      case "awaiting_content":
        newFields.content = userText;
        const auth = await authenticateGoogle();
        await runCommand(auth, "SAVE_MEMORY", newFields);
        reply = `🧠 Memória salva com o título: *${newFields.title}*`;
        await endTask(chatId);
        nextStage = null;
        break;

      default:
        reply = "Quer registrar outra memória?";
        await endTask(chatId);
        nextStage = null;
    }
  } catch (err) {
    reply = `❌ Erro ao salvar memória: ${err.message}`;
    await endTask(chatId);
  }

  await updateContext(chatId, { intent, fields: newFields, stage: nextStage });
  return reply;
}

// ============================================================
// 🚫 CANCELAR FLUXO
// ============================================================
async function handleCancel(chatId) {
  logFlow("CANCEL");
  await endTask(chatId);
  return "🚫 Ação atual cancelada. Pode pedir outra coisa!";
}

// ============================================================
// 🧭 ROTEADOR PRINCIPAL
// ============================================================
export async function routeDialog(chatId, userText) {
  const lower = userText.toLowerCase().trim();
  logFlow("ROUTER", { chatId, lower });
  const state = await getDialogState(chatId);

  if (lower.match(/(cancel(e|ar)|pare|parar|recomeçar|resetar|novo comando|cancele o que está fazendo)/))
    return await handleCancel(chatId);

  if (state.intent && state.stage) {
    switch (state.intent) {
      case "CREATE_EVENT": return await handleCreateEvent(chatId, userText);
      case "READ_EMAILS": return await handleReadEmails(chatId, userText);
      case "SEND_EMAIL": return await handleSendEmail(chatId, userText);
      case "SAVE_MEMORY": return await handleSaveMemory(chatId, userText);
    }
  }

  if (lower.match(/(agenda|compromisso|minha agenda|mostrar calendário|ver agenda)/))
    return await handleShowAgenda(chatId);
  if (lower.match(/\b(reuni|evento|agend(ar|e))/))
    return await handleCreateEvent(chatId, userText);
  if (lower.match(/(ler|leia).*(e-?mail|mail)/))
    return await handleReadEmails(chatId, userText);
  if (lower.match(/(enviar|mande|envie).*(e-?mail|mail)/))
    return await handleSendEmail(chatId, userText);
  if (lower.match(/(salvar|memóri|memoria)/))
    return await handleSaveMemory(chatId, userText);

  return "Desculpe, não entendi o que deseja fazer. Você pode pedir, por exemplo:\n- 'Agende uma reunião'\n- 'Leia meus e-mails'\n- 'Envie um e-mail'\n- 'Salve uma memória'\n- 'Mostre minha agenda'\n- 'Cancele o que está fazendo'";
}
