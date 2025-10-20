// apps/amana/dialogFlows.js
// 💬 Motor de diálogo completo e instrumentado (logs detalhados)

import { updateContext, getDialogState, beginTask, endTask } from "./memory.js";
import { authenticateGoogle, runCommand } from "./google.js";

// Utilitário de log
const log = (scope, msg, data = null) => {
  const time = new Date().toISOString().split("T")[1].split(".")[0];
  console.log(`🧭 [${time}] [${scope}] ${msg}`, data ? JSON.stringify(data) : "");
};

// ============================================================
// 🗓️ CRIAR EVENTO
// ============================================================
async function handleCreateEvent(chatId, userText) {
  log("EVENT", `Fluxo CREATE_EVENT iniciado`, { chatId, userText });
  const state = await getDialogState(chatId);
  const intent = state.intent || "CREATE_EVENT";
  const fields = state.fields || {};
  const stage = state.stage || "start";
  let reply = "";
  let nextStage = stage;
  const newFields = { ...fields };

  log("EVENT", `Etapa atual: ${stage}`);

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
        nextStage = "awaiting_attendees";
      }
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
    } else {
      reply = "Vamos recomeçar o agendamento?";
      await endTask(chatId);
      nextStage = null;
    }

    log("EVENT", `Etapa concluída`, { stage: nextStage, reply });
    await updateContext(chatId, { intent, fields: newFields, stage: nextStage });
    return reply;
  } catch (err) {
    log("EVENT", `Erro: ${err.message}`);
    return "❌ Erro ao criar evento.";
  }
}

// ============================================================
// ROTEADOR PRINCIPAL
// ============================================================
export async function routeDialog(chatId, userText) {
  const lower = (userText || "").toLowerCase();
  log("ROUTER", "routeDialog chamado", { chatId, userText });

  const state = await getDialogState(chatId);
  log("ROUTER", "Contexto recuperado", state);

  try {
    if (state.intent && state.stage) {
      switch (state.intent) {
        case "CREATE_EVENT":
          return await handleCreateEvent(chatId, userText);
      }
    }

    if (lower.includes("reuni") || lower.includes("evento") || lower.includes("agendar"))
      return await handleCreateEvent(chatId, userText);

    log("ROUTER", "Nenhuma intenção reconhecida.");
    return "Desculpe, não entendi o que deseja fazer. Você pode pedir, por exemplo:\n- 'Agende uma reunião'\n- 'Leia meus e-mails'\n- 'Envie um e-mail'\n- 'Salve uma memória'";
  } catch (err) {
    log("ROUTER", `Erro inesperado: ${err.message}`);
    return "⚠️ Ocorreu um erro no processamento.";
  }
}
