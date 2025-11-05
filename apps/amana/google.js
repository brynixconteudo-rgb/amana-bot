// apps/amana/google.js
import { google } from "googleapis";
import { Readable } from "stream";
import crypto from "crypto";

const TZ = "America/Sao_Paulo";

// ============================================================
// 🔎 Util: ENV + logs
// ============================================================
function envGet(k, alt) {
  return process.env[k] || (alt ? process.env[alt] : undefined);
}
function logInfo(obj, msg) { try { console.log("[AMANA][INFO]", msg, JSON.stringify(obj)); } catch { console.log("[AMANA][INFO]", msg); } }
function logErr(obj, msg) { try { console.error("[AMANA][ERROR]", msg, JSON.stringify(obj)); } catch { console.error("[AMANA][ERROR]", msg); } }

// Escopos necessários para tudo que o BOT faz
const REQUIRED_SCOPES = new Set([
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/spreadsheets",
]);

// ============================================================
// 🔐 AUTENTICAÇÃO GOOGLE VIA OAUTH (somente ENV, sem cache)
// ============================================================
export async function authenticateGoogle() {
  const CLIENT_ID = envGet("GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_CLIENT_ID");
  const CLIENT_SECRET = envGet("GOOGLE_OAUTH_CLIENT_SECRET", "GOOGLE_CLIENT_SECRET");
  const REFRESH_TOKEN = envGet("GOOGLE_OAUTH_REFRESH_TOKEN", "GOOGLE_REFRESH_TOKEN");

  if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) {
    throw new Error("Variáveis OAuth ausentes. Defina GOOGLE_OAUTH_CLIENT_ID / SECRET / REFRESH_TOKEN (ou os aliases GOOGLE_CLIENT_*).");
  }

  // Redirect não é usado no fluxo de refresh, mas mantemos o do Playground para consistência.
  const oauth2Client = new google.auth.OAuth2(
    CLIENT_ID,
    CLIENT_SECRET,
    "https://developers.google.com/oauthplayground"
  );

  oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });

  // 🔍 Diagnóstico: verificar escopos do access token em runtime
  try {
    const { token } = await oauth2Client.getAccessToken();
    if (!token) throw new Error("Falha ao obter access_token a partir do refresh_token.");
    const r = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${token}`);
    const info = await r.json();
    const scopes = String(info.scope || "").split(" ").filter(Boolean);
    const scopesSet = new Set(scopes);

    logInfo({ gotToken: true, scopes }, "GOOGLE_OAUTH_TOKENINFO");

    // Aceita gmail.modify como extra, mas exige os abaixo.
    const missing = [];
    for (const s of REQUIRED_SCOPES) if (!scopesSet.has(s)) missing.push(s);

    if (missing.length) {
      throw new Error(
        `Insufficient Permission (escopos ausentes no token): ${missing.join(", ")}. ` +
        `Regenere o refresh_token no OAuth Playground com TODOS: ` +
        `https://www.googleapis.com/auth/calendar ` +
        `https://www.googleapis.com/auth/gmail.readonly ` +
        `https://www.googleapis.com/auth/gmail.send ` +
        `https://www.googleapis.com/auth/drive ` +
        `https://www.googleapis.com/auth/spreadsheets`
      );
    }
  } catch (e) {
    logErr({ message: String(e?.message || e) }, "GOOGLE_OAUTH_SCOPE_CHECK_FAILED");
    throw e;
  }

  return oauth2Client;
}

// ============================================================
// 🧩 TESTE DE CONEXÃO
// ============================================================
export async function googleTest(auth) {
  const drive = google.drive({ version: "v3", auth });
  const gmail = google.gmail({ version: "v1", auth });
  const calendar = google.calendar({ version: "v3", auth });

  const driveInfo = await drive.about.get({ fields: "user,storageQuota" }).catch(e => ({ data: {}, _err: e }));
  const calendars = await calendar.calendarList.list({ maxResults: 5 }).catch(e => ({ data: { items: [] }, _err: e }));
  const labels = await gmail.users.labels.list({ userId: "me" }).catch(e => ({ data: { labels: [] }, _err: e }));

  return {
    drive_user: driveInfo?.data?.user?.displayName || "desconhecido",
    total_storage: String(driveInfo?.data?.storageQuota?.limit || "0"),
    calendars: (calendars?.data?.items || []).map((c) => c.summary),
    gmail_labels: (labels?.data?.labels || []).slice(0, 5).map((l) => l.name),
  };
}

// ============================================================
// 🧭 ROTEADOR DE COMANDOS
// ============================================================
const DRIVE_FOLDER_BASE = process.env.DRIVE_FOLDER_BASE;
const SHEETS_SPREADSHEET_ID = process.env.SHEETS_SPREADSHEET_ID;

export async function runCommand(auth, command, data = {}) {
  let result;
  logInfo({ command, dataKeys: Object.keys(data || {}) }, "RUN_COMMAND");
  switch (command) {
    case "SAVE_FILE":
      result = await saveFile(auth, data); break;
    case "SEND_EMAIL":
      result = await sendEmail(auth, data); break;
    case "CREATE_EVENT":
      result = await createEvent(auth, data); break;
    case "SHOW_AGENDA":
      result = await showAgenda(auth, data); break;
    case "SAVE_MEMORY":
      result = await saveMemory(auth, data); break;
    case "READ_EMAILS":
      result = await readEmails(auth, data); break;
    default:
      throw new Error(`Comando desconhecido: ${command}`);
  }
  await updateIndex(auth, { command, data, result }).catch(e => logErr({ err: String(e) }, "UPDATE_INDEX_FAILED"));
  return result;
}

// ============================================================
// 1️⃣ SALVAR ARQUIVO NO DRIVE
// ============================================================
async function saveFile(auth, { name, mimeType = "text/plain", base64, text, folderId }) {
  const drive = google.drive({ version: "v3", auth });
  const parents = [folderId || DRIVE_FOLDER_BASE].filter(Boolean);
  const bodyBuffer = base64 ? Buffer.from(base64, "base64") : Buffer.from(text || "", "utf-8");
  const fileMetadata = { name: name || "sem_nome.txt", ...(parents.length ? { parents } : {}) };
  const media = { mimeType, body: Readable.from(bodyBuffer) };
  const created = await drive.files.create({
    requestBody: fileMetadata,
    media,
    fields: "id,name,webViewLink,webContentLink,parents"
  });
  return created.data;
}

// ============================================================
// 2️⃣ ENVIAR E-MAIL
// ============================================================
async function sendEmail(auth, { to, cc, bcc, subject, html, body }) {
  const gmail = google.gmail({ version: "v1", auth });

  if (!to || (Array.isArray(to) && to.length === 0)) throw new Error("Nenhum destinatário informado.");
  const recipients = Array.isArray(to) ? to.join(", ") : to;

  const headers = [
    `To: ${recipients}`,
    cc ? `Cc: ${cc}` : null,
    bcc ? `Bcc: ${bcc}` : null,
    "MIME-Version: 1.0",
    "Content-Type: text/html; charset=UTF-8",
    `Subject: ${subject || "(sem assunto)"}`
  ].filter(Boolean).join("\n");

  const message = `${headers}\n\n${html || body || ""}`;
  const encodedMessage = Buffer.from(message).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  const sent = await gmail.users.messages.send({ userId: "me", requestBody: { raw: encodedMessage } });
  return { id: sent.data.id, to: recipients, subject };
}

// ============================================================
// 3️⃣ CRIAR EVENTO NO CALENDAR
// ============================================================
async function createEvent(auth, { summary, start, end, attendees = [], location, description }) {
  const calendar = google.calendar({ version: "v3", auth });
  const cleanEmails = (arr) =>
    (Array.isArray(arr) ? arr : [])
      .map((v) => String(v || "").trim().toLowerCase())
      .filter((v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v));

  const attendeesClean = cleanEmails(attendees);

  const event = {
    summary: summary || "Evento",
    location,
    description,
    start: { dateTime: start, timeZone: TZ },
    end: { dateTime: end, timeZone: TZ },
    ...(attendeesClean.length ? { attendees: attendeesClean.map((email) => ({ email })) } : {}),
    reminders: { useDefault: true },
  };

  const res = await calendar.events.insert({ calendarId: "primary", requestBody: event });
  return res.data;
}

// ============================================================
// 4️⃣ MOSTRAR AGENDA
// ============================================================
async function showAgenda(auth, { maxResults = 5 } = {}) {
  const calendar = google.calendar({ version: "v3", auth });
  const now = new Date();
  const endOfDay = new Date(); endOfDay.setHours(23, 59, 59);

  try {
    const res = await calendar.events.list({
      calendarId: "primary",
      timeMin: now.toISOString(),
      timeMax: endOfDay.toISOString(),
      singleEvents: true,
      orderBy: "startTime",
      maxResults,
    });
    const events = res.data.items || [];
    return {
      events: events.map(ev => ({
        summary: ev.summary || "Sem título",
        startTime: ev.start?.dateTime || ev.start?.date,
        endTime: ev.end?.dateTime || ev.end?.date,
      })),
    };
  } catch (err) {
    const status = err?.response?.status;
    const data = err?.response?.data;
    logErr({ status, data }, "CAL_EVENTS_LIST_ERROR");
    throw err;
  }
}

// ============================================================
// 5️⃣ REGISTRAR MEMÓRIA NO SHEETS
// ============================================================
async function saveMemory(auth, { title = "", content = "", tags = [] }) {
  const sheets = google.sheets({ version: "v4", auth });
  if (!SHEETS_SPREADSHEET_ID)
    return { title, content, tags, note: "SHEETS_SPREADSHEET_ID ausente" };

  const values = [[new Date().toISOString(), title, content, (tags || []).join(", ")]];
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEETS_SPREADSHEET_ID,
    range: "Memoria_Viva!A:D",
    valueInputOption: "RAW",
    requestBody: { values }
  });
  return { title, content, tags };
}

// ============================================================
// 6️⃣ LER E-MAILS
// ============================================================
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
    const headers = (msg.data.payload?.headers || []).reduce((acc, h) => (acc[h.name] = h.value, acc), {});
    details.push({ id: m.id, from: headers.From, subject: headers.Subject, date: headers.Date });
  }

  return { total: details.length, query, emails: details };
}

// ============================================================
// 7️⃣ ATUALIZAR ARQUIVO DE LOG (Amana_INDEX.json)
// ============================================================
async function updateIndex(auth, { command, data, result }) {
  const drive = google.drive({ version: "v3", auth });
  const indexName = "Amana_INDEX.json";
  const hash = crypto.createHash("sha256").update(JSON.stringify({ command, data, result })).digest("hex");

  const qParts = [`name='${indexName}'`, "trashed=false"];
  if (process.env.DRIVE_FOLDER_BASE) qParts.push(`'${process.env.DRIVE_FOLDER_BASE}' in parents`);

  const search = await drive.files.list({ q: qParts.join(" and "), fields: "files(id,name)" });

  let indexId;
  let indexData = { registros: [] };

  if (search.data.files?.length) {
    indexId = search.data.files[0].id;
    const file = await drive.files.get({ fileId: indexId, alt: "media" });
    try { indexData = JSON.parse(file.data); } catch { indexData = { registros: [] }; }
  }

  indexData.registros.push({ timestamp: new Date().toISOString(), command, data, result, hash });
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
        ...(process.env.DRIVE_FOLDER_BASE ? { parents: [process.env.DRIVE_FOLDER_BASE] } : {}),
      },
      media: { mimeType: "application/json", body: Readable.from(bodyBuffer) }
    });
  }
  return { status: "indexed", total_registros: indexData.registros.length };
}
