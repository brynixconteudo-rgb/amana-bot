import { google } from "googleapis";
import { Readable } from "stream";
import crypto from "crypto";

// ---------- autenticação ----------
export async function authenticateGoogle() {
  const {
    GOOGLE_OAUTH_CLIENT_ID,
    GOOGLE_OAUTH_CLIENT_SECRET,
    GOOGLE_OAUTH_REFRESH_TOKEN
  } = process.env;

  if (!GOOGLE_OAUTH_CLIENT_ID || !GOOGLE_OAUTH_CLIENT_SECRET || !GOOGLE_OAUTH_REFRESH_TOKEN) {
    throw new Error("Variáveis OAuth ausentes. Defina GOOGLE_OAUTH_CLIENT_ID / SECRET / REFRESH_TOKEN.");
  }

  const oauth2Client = new google.auth.OAuth2(
    GOOGLE_OAUTH_CLIENT_ID,
    GOOGLE_OAUTH_CLIENT_SECRET,
    "https://developers.google.com/oauthplayground"
  );
  oauth2Client.setCredentials({ refresh_token: GOOGLE_OAUTH_REFRESH_TOKEN });
  return oauth2Client;
}

// ---------- teste básico ----------
export async function googleTest(auth) {
  const drive = google.drive({ version: "v3", auth });
  const gmail = google.gmail({ version: "v1", auth });
  const calendar = google.calendar({ version: "v3", auth });

  const driveInfo = await drive.about.get({ fields: "user,storageQuota" });
  const calendars = await calendar.calendarList.list({ maxResults: 5 });
  const labels = await gmail.users.labels.list({ userId: "me" });

  return {
    drive_user: driveInfo.data.user?.displayName || "desconhecido",
    total_storage: String(driveInfo.data.storageQuota?.limit || "0"),
    calendars: (calendars.data.items || []).map((c) => c.summary),
    gmail_labels: (labels.data.labels || []).slice(0, 5).map((l) => l.name)
  };
}

// ---------- roteador de comandos ----------
const DRIVE_FOLDER_BASE = process.env.DRIVE_FOLDER_BASE;
const SHEETS_SPREADSHEET_ID = process.env.SHEETS_SPREADSHEET_ID;

export async function runCommand(auth, command, data = {}) {
  let result;
  switch (command) {
    case "SAVE_FILE":
      result = await saveFile(auth, data);
      break;
    case "SEND_EMAIL":
      result = await sendEmail(auth, data);
      break;
    case "CREATE_EVENT":
      result = await createEvent(auth, data);
      break;
    case "SAVE_MEMORY":
      result = await saveMemory(auth, data);
      break;
    case "READ_EMAILS":
      result = await readEmails(auth, data);
      break;
    default:
      throw new Error(`Comando desconhecido: ${command}`);
  }

  // após cada execução, registrar no Amana_INDEX.json
  await updateIndex(auth, { command, data, result });
  return result;
}

// ---------- 1) salvar arquivo no Drive ----------
async function saveFile(
  auth,
  { name, mimeType = "text/plain", base64, text, folderId }
) {
  const drive = google.drive({ version: "v3", auth });
  const parents = [folderId || DRIVE_FOLDER_BASE];
  const bodyBuffer = base64
    ? Buffer.from(base64, "base64")
    : Buffer.from(text || "", "utf-8");
  const fileMetadata = { name: name || "sem_nome.txt", parents };
  const media = { mimeType, body: Readable.from(bodyBuffer) };
  const created = await drive.files.create({
    requestBody: fileMetadata,
    media,
    fields: "id,name,webViewLink,webContentLink,parents"
  });
  return created.data;
}

// ---------- 2) enviar e-mail ----------
async function sendEmail(auth, { to, cc, bcc, subject, html }) {
  const gmail = google.gmail({ version: "v1", auth });
  const headers = [
    `To: ${to}`,
    cc ? `Cc: ${cc}` : null,
    bcc ? `Bcc: ${bcc}` : null,
    "MIME-Version: 1.0",
    "Content-Type: text/html; charset=UTF-8",
    `Subject: ${subject || "(sem assunto)"}`
  ]
    .filter(Boolean)
    .join("\n");
  const message = `${headers}\n\n${html || ""}`;
  const encodedMessage = Buffer.from(message)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const sent = await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw: encodedMessage }
  });
  return { id: sent.data.id, to, subject };
}

// ---------- 3) criar evento no Calendar ----------
function normalizeEmails(input) {
  if (!input) return [];
  const items = Array.isArray(input) ? input : [input];
  return items
    .map((v) => (typeof v === "string" ? v.trim() : v?.email?.trim()))
    .filter(Boolean)
    // ignora frases tipo "apenas eu", "só eu", nomes sem @ etc.
    .filter((v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v));
}

async function createEvent(auth, { summary, start, end, attendees = [], location, description }) {
  const calendar = google.calendar({ version: "v3", auth });

  const cleanAttendees = normalizeEmails(attendees).map((email) => ({ email }));

  const event = {
    summary,
    location,
    description,
    start: { dateTime: start },
    end: { dateTime: end },
    // só envia attendees se tiver e-mail válido
    ...(cleanAttendees.length ? { attendees: cleanAttendees } : {}),
    reminders: { useDefault: true },
  };

  const res = await calendar.events.insert({
    calendarId: "primary",
    requestBody: event,
  });
  return res.data;
}

// ---------- 4) registrar memória no Sheets ----------
async function saveMemory(auth, { projeto = "", memoria = "", tags = [] }) {
  const sheets = google.sheets({ version: "v4", auth });
  const values = [[new Date().toISOString(), projeto, memoria, (tags || []).join(", ")]];
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEETS_SPREADSHEET_ID,
    range: "Memoria_Viva!A:D",
    valueInputOption: "RAW",
    requestBody: { values }
  });
  return { projeto, memoria, tags };
}

// ---------- 5) ler e-mails ----------
async function readEmails(auth, { maxResults = 5, query = "is:unread" }) {
  const gmail = google.gmail({ version: "v1", auth });
  const res = await gmail.users.messages.list({ userId: "me", maxResults, q: query });
  const messages = res.data.messages || [];
  const details = [];
  for (const m of messages) {
    const msg = await gmail.users.messages.get({
      userId: "me",
      id: m.id,
      format: "metadata",
      metadataHeaders: ["From", "Subject", "Date"]
    });
    const headers = msg.data.payload.headers.reduce((acc, h) => {
      acc[h.name] = h.value;
      return acc;
    }, {});
    details.push({
      id: m.id,
      from: headers.From,
      subject: headers.Subject,
      date: headers.Date,
      summary: summarizeEmail(headers.Subject)
    });
  }
  return { total: details.length, query, emails: details };
}

function summarizeEmail(subject = "") {
  const text = subject.toLowerCase();
  if (text.includes("reunião") || text.includes("agenda")) return "Possível reunião";
  if (text.includes("proposta") || text.includes("contrato")) return "Assunto comercial";
  if (text.includes("fatura") || text.includes("pagamento")) return "Financeiro";
  return "Geral";
}

// ---------- 6) atualizar Amana_INDEX.json ----------
async function updateIndex(auth, { command, data, result }) {
  const drive = google.drive({ version: "v3", auth });
  const indexName = "Amana_INDEX.json";
  const hash = crypto.createHash("sha256").update(JSON.stringify({ command, data, result })).digest("hex");

  // buscar se já existe
  const search = await drive.files.list({
    q: `name='${indexName}' and '${DRIVE_FOLDER_BASE}' in parents and trashed=false`,
    fields: "files(id,name)"
  });

  let indexId;
  let indexData = { registros: [] };

  if (search.data.files.length > 0) {
    indexId = search.data.files[0].id;
    const file = await drive.files.get({ fileId: indexId, alt: "media" });
    try {
      indexData = JSON.parse(file.data);
    } catch {
      indexData = { registros: [] };
    }
  }

  // adiciona novo registro
  indexData.registros.push({
    timestamp: new Date().toISOString(),
    command,
    data,
    result,
    hash
  });

  const bodyBuffer = Buffer.from(JSON.stringify(indexData, null, 2), "utf-8");

  if (indexId) {
    await drive.files.update({
      fileId: indexId,
      media: { mimeType: "application/json", body: Readable.from(bodyBuffer) }
    });
  } else {
    await drive.files.create({
      requestBody: {
        name: indexName,
        mimeType: "application/json",
        parents: [DRIVE_FOLDER_BASE]
      },
      media: { mimeType: "application/json", body: Readable.from(bodyBuffer) }
    });
  }

  return { status: "indexed", total_registros: indexData.registros.length };
}
