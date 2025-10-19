// 🌐 Motor de diálogo do Amana_BOT — versão com NLP simplificado
// Compatível com OAuth (sem Service Account)

import { updateContext, getDialogState, beginTask, endTask } from "./memory.js";
import { authenticateGoogle, runCommand } from "./google.js";

// ------------------------------------------------------------
// 🔹 Funções de similaridade e normalização
// ------------------------------------------------------------
function normalize(text) {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, ""); // remove acentos
}

function matches(text, keywords) {
  const clean = normalize(text);
  return keywords.some((k) => clean.includes(normalize(k)));
}

// ------------------------------------------------------------
// 🗓️ CRIAR EVENTO
// ------------------------------------------------------------
async function handleCreateEvent(chatId, userText) {
  const state = await getDialogState(chatId);
  const intent = state.intent || "CREATE_EVENT";
  const fields = state.fields || {};
  const stage = state.stage || "start";
  let reply = "";
  let nextStage = stage;
  const newFields = { ...fields };

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
    try {
      const auth = await authenticateGoogle();
      await runCommand(auth, "CREATE_EVENT", newFields);
      reply = `📅 Evento criado com sucesso: *${newFields.summary}*`;
    } catch (err) {
      reply = `❌ Erro ao criar o evento: ${err.message}`;
    }
    await endTask(chatId);
    nextStage = null;
  } else {
    reply = "Vamos recomeçar o agendamento?";
    await endTask(chatId);
    nextStage = null;
  }

  await updateContext(chatId, { intent, fields: newFields, stage: nextStage });
  return reply;
}

// ------------------------------------------------------------
// 📬 LER EMAILS
// ------------------------------------------------------------
async function handleReadEmails(chatId, userText) {
  const state = await getDialogState(chatId);
  const intent = state.intent || "READ_EMAILS";
  const fields = state.fields || {};
  const stage = state.stage || "start";
  let reply = "";
  let nextStage = stage;
  const newFields = { ...fields };

  if (stage === "start") {
    await beginTask(chatId, intent, {});
    reply = "Quer que eu leia e-mails não lidos ou apenas os importantes?";
    nextStage = "awaiting_scope";
  } else if (stage === "awaiting_scope") {
    if (userText.toLowerCase().includes("importantes")) {
      newFields.query = "label:important";
    } else {
      newFields.query = "is:unread";
    }
    reply = "Quantos e-mails devo ler?";
    nextStage = "awaiting_quantity";
  } else if (stage === "awaiting_quantity") {
    const num = parseInt(userText.match(/\d+/)?.[0] || "3");
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
  } else if (stage === "awaiting_continue") {
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
    } else {
      reply = "Não entendi. Deseja continuar lendo? (sim/não)";
    }
  } else {
    reply = "Quer recomeçar a leitura dos e-mails?";
    await endTask(chatId);
    nextStage = null;
  }

  await updateContext(chatId, { intent, fields: newFields, stage: nextStage });
  return reply;
}

// ------------------------------------------------------------
// 🧭 ROTEADOR PRINCIPAL COM INTELIGÊNCIA LEVE
// ------------------------------------------------------------
export async function routeDialog(chatId, userText) {
  const lower = normalize(userText);

  // 1️⃣ Se há contexto ativo → continua o fluxo anterior
  const state = await getDialogState(chatId);
  if (state.intent && state.stage) {
    switch (state.intent) {
      case "CREATE_EVENT": return await handleCreateEvent(chatId, userText);
      case "READ_EMAILS": return await handleReadEmails(chatId, userText);
    }
  }

  // 2️⃣ Detecta intenção inicial (com sinônimos e linguagem natural)
  if (matches(lower, ["reuniao", "agenda", "marcar", "agendar", "encontro", "reuni"])) {
    return await handleCreateEvent(chatId, userText);
  }

  if (matches(lower, ["email", "emails", "mensagem", "caixa", "inbox", "ler email", "meus emails", "olha meus emails"])) {
    return await handleReadEmails(chatId, userText);
  }

  // 3️⃣ Fallback
  return "Desculpe, não entendi o que deseja fazer. Você pode pedir, por exemplo:\n- 'Agende uma reunião'\n- 'Leia meus e-mails'\n- 'Envie um e-mail'\n- 'Salve uma memória'";
}
