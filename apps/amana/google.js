// apps/amana/google.js
// 🔧 Versão 100% compatível com OAuth (usuário pessoal Gmail/Calendar)
// Última revisão: 2025-10-19

import { google } from "googleapis";
import chalk from "chalk";

// ============================================================
// 🔐 Autenticação via OAuth (usuário pessoal)
// ============================================================
export async function authenticateGoogle() {
  try {
    const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    const refreshToken = process.env.GOOGLE_OAUTH_REFRESH_TOKEN;

    if (!clientId || !clientSecret || !refreshToken) {
      throw new Error("Variáveis OAuth ausentes (clientId, clientSecret ou refreshToken).");
    }

    const oAuth2Client = new google.auth.OAuth2(clientId, clientSecret);
    oAuth2Client.setCredentials({ refresh_token: refreshToken });

    // Define como cliente padrão global
    google.options({ auth: oAuth2Client });

    console.log(chalk.green("✅ Autenticação Google OAuth configurada."));
    return oAuth2Client;
  } catch (err) {
    console.error(chalk.red("❌ Erro ao autenticar via OAuth:"), err.message);
    throw err;
  }
}

// ============================================================
// 🧠 Teste rápido
// ============================================================
export async function googleTest(auth) {
  try {
    const calendar = google.calendar({ version: "v3", auth });
    const res = await calendar.calendarList.list({ maxResults: 2 });
    return res.data.items?.map((c) => c.summary) || [];
  } catch (err) {
    console.error("❌ Erro no googleTest:", err.message);
    throw err;
  }
}

// ============================================================
// ⚙️ Roteador de comandos
// ============================================================
export async function runCommand(auth, command, data = {}) {
  console.log(chalk.cyan(`⚙️ Executando comando: ${command}`));

  switch (command) {
    case "CREATE_EVENT":
      return await createEvent(auth, data);
    case "READ_EMAILS":
      return await readEmails(auth, data);
    case "SEND_EMAIL":
      return await sendEmail(auth, data);
    default:
      console.warn(chalk.yellow("⚠️ Comando desconhecido:"), command);
      return { status: "ignored", command };
  }
}

// ============================================================
// 📅 Criação de evento no Google Calendar
// ============================================================
async function createEvent(auth, data) {
  try {
    const calendar = google.calendar({ version: "v3", auth });
    const attendees =
      data.attendees?.map((email) => ({ email })) || [];

    const event = {
      summary: data.summary || "Reunião sem título",
      description: data.description || "Criado automaticamente pelo Amana_BOT",
      start: { dateTime: data.start, timeZone: "America/Sao_Paulo" },
      end: { dateTime: data.end, timeZone: "America/Sao_Paulo" },
      attendees,
      reminders: {
        useDefault: false,
        overrides: [
          { method: "popup", minutes: 10 },
          { method: "email", minutes: 30 },
        ],
      },
    };

    const response = await calendar.events.insert({
      calendarId: "primary",
      resource: event,
      sendUpdates: "all",
    });

    console.log(chalk.greenBright("📅 Evento criado com sucesso:"), response.data.summary);
    return { id: response.data.id, summary: response.data.summary };
  } catch (err) {
    console.error(chalk.red("❌ Erro ao criar evento:"), err.message);
    throw err;
  }
}

// ============================================================
// ✉️ Envio de e-mail via Gmail
// ============================================================
async function sendEmail(auth, { to, subject, body }) {
  try {
    const gmail = google.gmail({ version: "v1", auth });
    if (!to) throw new Error("Destinatário (to) não informado.");

    const message = [
      `To: ${to}`,
      "Content-Type: text/plain; charset=utf-8",
      "MIME-Version: 1.0",
      `Subject: ${subject || "(Sem assunto)"}`,
      "",
      body || "",
    ].join("\n");

    const encodedMessage = Buffer.from(message)
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    const response = await gmail.users.messages.send({
      userId: "me",
      requestBody: { raw: encodedMessage },
    });

    console.log(chalk.greenBright("📨 E-mail enviado para:"), to);
    return { id: response.data.id, to, subject };
  } catch (err) {
    console.error(chalk.red("❌ Erro ao enviar e-mail:"), err.message);
    throw err;
  }
}

// ============================================================
// 📬 Leitura de e-mails
// ============================================================
async function readEmails(auth, { query = "is:unread", maxResults = 5 } = {}) {
  try {
    const gmail = google.gmail({ version: "v1", auth });
    const list = await gmail.users.messages.list({
      userId: "me",
      q: query,
      maxResults,
    });

    if (!list.data.messages?.length) {
      console.log("📭 Nenhum e-mail encontrado.");
      return { emails: [] };
    }

    const emails = [];
    for (const msg of list.data.messages) {
      const full = await gmail.users.messages.get({
        userId: "me",
        id: msg.id,
        format: "metadata",
        metadataHeaders: ["From", "Subject"],
      });

      const headers = Object.fromEntries(
        full.data.payload.headers.map((h) => [h.name, h.value])
      );
      emails.push({ from: headers.From, subject: headers.Subject });
    }

    console.log(chalk.blueBright(`📬 ${emails.length} e-mails recuperados.`));
    return { emails };
  } catch (err) {
    console.error(chalk.red("❌ Erro ao ler e-mails:"), err.message);
    throw err;
  }
}
