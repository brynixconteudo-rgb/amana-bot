// apps/amana/toolbox.js
// 🧰 Caixa de ferramentas do Amana_BOT
// - Drive (Service Account): salvar arquivos, listar, garantir pastas, indexar
// - Gmail/Calendar/Sheets (OAuth do usuário): e-mail, agenda, memórias
//
// Como usar via CLI:
//   node apps/amana/toolbox.js --cmd SAVE_CONTEXT
//   node apps/amana/toolbox.js --cmd SHOW_AGENDA --data '{"max":5}'
//   node apps/amana/toolbox.js --cmd SEND_EMAIL --data '{"to":"x@y.com","subject":"Oi","html":"<b>Hello</b>"}'
//
// Como usar via código:
//   import { runOp } from "./apps/amana/toolbox.js";
//   const r = await runOp("SAVE_CONTEXT");

import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import crypto from "crypto";
import { google } from "googleapis";

// ======================= ENV / CONSTANTES =======================
const TZ = "America/Sao_Paulo";

// Pasta-base NO DRIVE (ID da pasta _OpenAI/Amana_BOT)
const DRIVE_FOLDER_BASE = process.env.DRIVE_FOLDER_BASE;

// Planilha para memórias (opcional, mas recomendado)
const SHEETS_SPREADSHEET_ID = process.env.SHEETS_SPREADSHEET_ID;

// -------- OAuth (USUÁRIO) p/ Gmail/Calendar/Sheets --------
const OAUTH = {
  id: process.env.GOOGLE_OAUTH_CLIENT_ID,
  secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
  refresh: process.env.GOOGLE_OAUTH_REFRESH_TOKEN,
  redirect: "https://developers.google.com/oauthplayground",
};

// -------- Service Account (DRIVE) --------
// Passe o JSON inteiro na variável GOOGLE_SA_KEY_JSON
// ou deixe um arquivo "service-account.json" na raiz do projeto.
async function readSAKeyJSON() {
  if (process.env.GOOGLE_SA_KEY_JSON) return JSON.parse(process.env.GOOGLE_SA_KEY_JSON);
  const p = path.resolve("service-account.json");
  return JSON.parse(await fsp.readFile(p, "utf8"));
}

// ======================= AUTH HELPERS =======================
async function authUserOAuth() {
  if (!OAUTH.id || !OAUTH.secret || !OAUTH.refresh) {
    throw new Error("OAuth ausente (GOOGLE_OAUTH_CLIENT_ID/SECRET/REFRESH_TOKEN).");
  }
  const oauth2 = new google.auth.OAuth2(OAUTH.id, OAUTH.secret, OAUTH.redirect);
  oauth2.setCredentials({ refresh_token: OAUTH.refresh });
  return oauth2;
}

async function authSAForDrive() {
  if (!DRIVE_FOLDER_BASE) throw new Error("DRIVE_FOLDER_BASE ausente (ID da pasta).");
  const { client_email, private_key } = await readSAKeyJSON();
  const scopes = ["https://www.googleapis.com/auth/drive"];
  const jwt = new google.auth.JWT(client_email, null, private_key, scopes);
  await jwt.authorize();
  return jwt;
}

// ======================= DRIVE (SA) =======================
function driveSA(auth) {
  return google.drive({ version: "v3", auth });
}

async function ensureSubfolders(auth) {
  const drive = driveSA(auth);
  const want = ["Arquivos", "Logs", "Memorias", "Relatorios", "Transcricoes"];
  const map = {};
  for (const name of want) {
    // procura por nome e parent
    const q = [
      `'${DRIVE_FOLDER_BASE}' in parents`,
      `name='${name.replace(/'/g, "\\'")}'`,
      "trashed=false",
      "mimeType='application/vnd.google-apps.folder'",
    ].join(" and ");
    const { data } = await drive.files.list({ q, fields: "files(id,name)" });
    if (data.files?.length) {
      map[name] = data.files[0].id;
    } else {
      const res = await drive.files.create({
        requestBody: {
          name,
          mimeType: "application/vnd.google-apps.folder",
          parents: [DRIVE_FOLDER_BASE],
        },
        fields: "id,name",
      });
      map[name] = res.data.id;
    }
  }
  return map; // {Arquivos, Logs, ...}
}

async function saveTextFileSA(auth, { name, text, parentId, mimeType = "text/plain" }) {
  const drive = driveSA(auth);
  const media = { mimeType, body: Buffer.from(text, "utf-8") };
  const res = await drive.files.create({
    requestBody: { name, parents: parentId ? [parentId] : [DRIVE_FOLDER_BASE] },
    media,
    fields: "id,name,webViewLink,parents",
  });
  return res.data;
}

async function upsertIndexSA(auth, { command, data, result }) {
  const drive = driveSA(auth);
  const indexName = "Amana_INDEX.json";
  const q = [
    `'${DRIVE_FOLDER_BASE}' in parents`,
    "trashed=false",
    `name='${indexName}'`,
    "mimeType!='application/vnd.google-apps.folder'",
  ].join(" and ");
  const search = await drive.files.list({ q, fields: "files(id,name)" });

  let fileId = null;
  let json = { registros: [] };

  if (search.data.files?.length) {
    fileId = search.data.files[0].id;
    const file = await drive.files.get({ fileId, alt: "media" }, { responseType: "text" });
    try { json = JSON.parse(file.data); } catch { json = { registros: [] }; }
  }

  const hash = crypto
    .createHash("sha256")
    .update(JSON.stringify({ command, data, result }))
    .digest("hex");

  json.registros.push({
    timestamp: new Date().toISOString(),
    command,
    data,
    result,
    hash,
  });

  const body = Buffer.from(JSON.stringify(json, null, 2), "utf-8");

  if (fileId) {
    await drive.files.update({ fileId, media: { mimeType: "application/json", body } });
  } else {
    const created = await drive.files.create({
      requestBody: {
        name: indexName,
        parents: [DRIVE_FOLDER_BASE],
        mimeType: "application/json",
      },
      media: { mimeType: "application/json", body },
      fields: "id",
    });
    fileId = created.data.id;
  }
  return { status: "indexed", fileId, total: json.registros.length };
}

// ======================= SNAPSHOT (DISCO → DRIVE) =======================
function sha1(buf) {
  return crypto.createHash("sha1").update(buf).digest("hex");
}

async function readIfExists(abs) {
  try {
    const data = await fsp.readFile(abs);
    return data;
  } catch {
    return null;
  }
}

async function collectFiles(root, relPaths) {
  const items = [];
  for (const rel of relPaths) {
    const abs = path.resolve(root, rel);
    const buf = await readIfExists(abs);
    if (!buf) continue;
    items.push({
      path: rel,
      size: buf.length,
      sha1: sha1(buf),
      b64: buf.toString("base64"),
    });
  }
  return items;
}

async function buildContextSnapshot() {
  // Lista “curada” de arquivos mais importantes do projeto.
  // Se quiser ampliar, basta adicionar aqui.
  const root = path.resolve(".");
  const curated = [
    "server.js",
    "ai.js",
    "voice.js",
    "package.json",
    "apps/amana/telegram.js",
    "apps/amana/dialogFlows.js",
    "apps/amana/google.js",
    "apps/amana/memory.js",
    "apps/amana/toolbox.js",
  ];

  // pega também todos .js dentro de apps/amana
  try {
    const dir = await fsp.readdir("apps/amana");
    for (const f of dir) {
      if (f.endsWith(".js") && !curated.includes(`apps/amana/${f}`)) {
        curated.push(`apps/amana/${f}`);
      }
    }
  } catch { /* ignore */ }

  const files = await collectFiles(root, curated);
  return {
    snapshot_at: new Date().toISOString(),
    total_files: files.length,
    files,
  };
}

async function saveContextToDrive() {
  const sa = await authSAForDrive();
  const folders = await ensureSubfolders(sa);
  const snap = await buildContextSnapshot();

  const nameJSON = `SNAPSHOT_${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  const saved = await saveTextFileSA(sa, {
    name: nameJSON,
    text: JSON.stringify(snap, null, 2),
    parentId: folders.Arquivos,
    mimeType: "application/json",
  });

  await upsertIndexSA(sa, {
    command: "SAVE_CONTEXT",
    data: { into: "Arquivos", file: nameJSON },
    result: { fileId: saved.id, webViewLink: saved.webViewLink, total_files: snap.total_files },
  });

  return { ok: true, fileId: saved.id, webViewLink: saved.webViewLink, total_files: snap.total_files };
}

// ======================= GMAIL / CALENDAR / SHEETS (OAuth) =======================
async function sendEmail({ to, cc, bcc, subject, html }) {
  const auth = await authUserOAuth();
  const gmail = google.gmail({ version: "v1", auth });

  const hdr = [
    `To: ${to}`,
    cc ? `Cc: ${cc}` : null,
    bcc ? `Bcc: ${bcc}` : null,
    "MIME-Version: 1.0",
    "Content-Type: text/html; charset=UTF-8",
    `Subject: ${subject || "(sem assunto)"}`,
  ].filter(Boolean).join("\n");

  const raw = Buffer.from(`${hdr}\n\n${html || ""}`).toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  const { data } = await gmail.users.messages.send({ userId: "me", requestBody: { raw } });
  await indexUserOp("SEND_EMAIL", { to, subject }, { id: data.id });
  return { id: data.id };
}

async function readEmails({ maxResults = 5, query = "is:unread" } = {}) {
  const auth = await authUserOAuth();
  const gmail = google.gmail({ version: "v1", auth });

  const list = await gmail.users.messages.list({ userId: "me", maxResults, q: query });
  const messages = list.data.messages || [];
  const details = [];
  for (const m of messages) {
    const msg = await gmail.users.messages.get({
      userId: "me", id: m.id, format: "metadata",
      metadataHeaders: ["From", "Subject", "Date"],
    });
    const hdr = Object.fromEntries((msg.data.payload?.headers || []).map(h => [h.name, h.value]));
    details.push({ id: m.id, from: hdr.From, subject: hdr.Subject, date: hdr.Date });
  }
  await indexUserOp("READ_EMAILS", { maxResults, query }, { total: details.length });
  return details;
}

async function createEvent({ summary, startISO, endISO, attendees = [], location, description }) {
  const auth = await authUserOAuth();
  const calendar = google.calendar({ version: "v3", auth });

  const event = {
    summary: summary || "Evento",
    location, description,
    start: { dateTime: startISO, timeZone: TZ },
    end:   { dateTime: endISO,   timeZone: TZ },
    ...(attendees.length ? { attendees: attendees.map(e => ({ email: e })) } : {}),
    reminders: { useDefault: true },
  };

  const { data } = await calendar.events.insert({ calendarId: "primary", requestBody: event });
  await indexUserOp("CREATE_EVENT", { summary, startISO, endISO, attendees }, { id: data.id });
  return { id: data.id, htmlLink: data.htmlLink };
}

async function showAgenda({ max = 5 } = {}) {
  const auth = await authUserOAuth();
  const calendar = google.calendar({ version: "v3", auth });

  const now = new Date().toISOString();
  const { data } = await calendar.events.list({
    calendarId: "primary",
    timeMin: now,
    maxResults: max,
    singleEvents: true,
    orderBy: "startTime",
  });

  const events = (data.items || []).map(ev => ({
    id: ev.id,
    summary: ev.summary || "Sem título",
    start: ev.start?.dateTime || ev.start?.date || "?",
    end: ev.end?.dateTime || ev.end?.date || "?",
  }));

  await indexUserOp("SHOW_AGENDA", { max }, { total: events.length });
  return events;
}

async function saveMemoryRow({ projeto = "", memoria = "", tags = [], origem = "toolbox" }) {
  if (!SHEETS_SPREADSHEET_ID) {
    return { note: "SHEETS_SPREADSHEET_ID ausente — ignorado." };
  }
  const auth = await authUserOAuth();
  const sheets = google.sheets({ version: "v4", auth });
  const values = [[new Date().toISOString(), projeto, memoria, (tags || []).join(", "), origem, ""]];
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEETS_SPREADSHEET_ID,
    range: "A:F",
    valueInputOption: "RAW",
    requestBody: { values },
  });
  await indexUserOp("SAVE_MEMORY_SHEET", { projeto, memoria, tags, origem }, { ok: true });
  return { ok: true };
}

// Usa o index no Drive (SA) para registrar tb as operações OAuth do usuário
async function indexUserOp(command, data, result) {
  try {
    const sa = await authSAForDrive();
    await upsertIndexSA(sa, { command, data, result });
  } catch (e) {
    console.warn("[indexUserOp] Falha ao indexar:", e?.message);
  }
}

// ======================= LISTAGEM / UTIL =======================
async function listDriveHere() {
  const sa = await authSAForDrive();
  const drive = driveSA(sa);
  const q = [
    `'${DRIVE_FOLDER_BASE}' in parents`,
    "trashed=false",
  ].join(" and ");
  const { data } = await drive.files.list({ q, pageSize: 100, fields: "files(id,name,mimeType,modifiedTime,owners,emailAddress)" });
  return data.files?.map(f => ({ id: f.id, name: f.name, mimeType: f.mimeType, modifiedTime: f.modifiedTime })) || [];
}

// ======================= ROTEADOR ÚNICO =======================
export async function runOp(cmd, payload = {}) {
  switch ((cmd || "").toUpperCase()) {
    case "SAVE_CONTEXT":      return await saveContextToDrive();
    case "SEND_EMAIL":        return await sendEmail(payload);
    case "READ_EMAILS":       return await readEmails(payload);
    case "CREATE_EVENT":      return await createEvent(payload);
    case "SHOW_AGENDA":       return await showAgenda(payload);
    case "SAVE_MEMORY_ROW":   return await saveMemoryRow(payload);
    case "LIST_DRIVE_HERE":   return await listDriveHere();
    default:
      throw new Error(`Comando desconhecido: ${cmd}`);
  }
}

// ======================= CLI =======================
if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    try {
      const args = Object.fromEntries(
        process.argv.slice(2).map(a => {
          const [k, ...r] = a.replace(/^--/, "").split("=");
          return [k, r.join("=")];
        })
      );
      const cmd = args.cmd;
      const data = args.data ? JSON.parse(args.data) : {};
      if (!cmd) throw new Error("Use: node apps/amana/toolbox.js --cmd <COMANDO> [--data '{...}']");
      console.log(`\n🧰 Executando ${cmd} ...`);
      const out = await runOp(cmd, data);
      console.log("✅ Resultado:", JSON.stringify(out, null, 2));
      process.exit(0);
    } catch (e) {
      console.error("❌ Erro:", e?.message);
      process.exit(1);
    }
  })();
}
