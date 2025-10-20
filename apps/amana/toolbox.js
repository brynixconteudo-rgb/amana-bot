// apps/amana/toolbox.js
// 🧰 Caixa de ferramentas do Amana_BOT — Drive, Gmail, Calendar, Sheets via OAuth (conta pessoal)
// - Usa apenas OAuth (sem Service Account)
// - Upload Drive com Readable.from (googleapis v131+)
// - Auto-chdir para raiz (não precisa executar da raiz)

import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import crypto from "crypto";
import chalk from "chalk";
import { Readable } from "stream";
import { fileURLToPath } from "url";
import { google } from "googleapis";

// ===== Caminho e raiz =====
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "../../");
try { process.chdir(PROJECT_ROOT); } catch {}

// ===== ENV =====
const TZ = "America/Sao_Paulo";
const DRIVE_FOLDER_BASE = process.env.DRIVE_FOLDER_BASE;
const SHEETS_SPREADSHEET_ID = process.env.SHEETS_SPREADSHEET_ID;
const OAUTH = {
  id: process.env.GOOGLE_OAUTH_CLIENT_ID,
  secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
  refresh: process.env.GOOGLE_OAUTH_REFRESH_TOKEN,
  redirect: "https://developers.google.com/oauthplayground",
};

// ===== OAuth Auth =====
async function authUserOAuth() {
  const { id, secret, refresh } = OAUTH;
  if (!id || !secret || !refresh)
    throw new Error("Faltam variáveis GOOGLE_OAUTH_CLIENT_ID/SECRET/REFRESH_TOKEN");
  const oauth2 = new google.auth.OAuth2(id, secret, OAUTH.redirect);
  oauth2.setCredentials({ refresh_token: refresh });
  return oauth2;
}

// ===== DRIVE (OAuth) =====
function driveUser(auth) {
  return google.drive({ version: "v3", auth });
}

async function ensureSubfoldersOAuth(auth) {
  const drive = driveUser(auth);
  const want = ["Arquivos", "Logs", "Memorias", "Relatorios", "Transcricoes"];
  const map = {};
  for (const name of want) {
    const q = [
      `'${DRIVE_FOLDER_BASE}' in parents`,
      `name='${name}'`,
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
  return map;
}

async function saveTextFileOAuth(auth, { name, text, parentId, mimeType = "text/plain" }) {
  const drive = driveUser(auth);
  const media = {
    mimeType,
    body: Readable.from([text ?? ""]),
  };
  const res = await drive.files.create({
    requestBody: { name, parents: [parentId || DRIVE_FOLDER_BASE] },
    media,
    fields: "id,name,webViewLink",
  });
  return res.data;
}

async function upsertIndexOAuth(auth, { command, data, result }) {
  const drive = driveUser(auth);
  const indexName = "Amana_INDEX.json";
  const q = [
    `'${DRIVE_FOLDER_BASE}' in parents`,
    "trashed=false",
    `name='${indexName}'`,
    "mimeType!='application/vnd.google-apps.folder'",
  ].join(" and ");
  const { data: search } = await drive.files.list({ q, fields: "files(id,name)" });
  let fileId = null;
  let json = { registros: [] };

  if (search.files?.length) {
    fileId = search.files[0].id;
    const file = await drive.files.get({ fileId, alt: "media" }, { responseType: "text" });
    try { json = JSON.parse(file.data); } catch {}
  }

  const hash = crypto.createHash("sha256")
    .update(JSON.stringify({ command, data, result }))
    .digest("hex");
  json.registros.push({ timestamp: new Date().toISOString(), command, data, result, hash });

  const bodyText = JSON.stringify(json, null, 2);
  const media = { mimeType: "application/json", body: Readable.from([bodyText]) };

  if (fileId) {
    await drive.files.update({ fileId, media });
  } else {
    const created = await drive.files.create({
      requestBody: { name: indexName, parents: [DRIVE_FOLDER_BASE], mimeType: "application/json" },
      media,
      fields: "id",
    });
    fileId = created.data.id;
  }
  return { status: "indexed", fileId, total: json.registros.length };
}

// ===== SNAPSHOT (DISCO → DRIVE) =====
const sha1 = (buf) => crypto.createHash("sha1").update(buf).digest("hex");

async function readIfExists(abs) {
  try { return await fsp.readFile(abs); } catch { return null; }
}

async function collectFiles(root, relPaths) {
  const items = [];
  for (const rel of relPaths) {
    const abs = path.resolve(root, rel);
    const buf = await readIfExists(abs);
    if (!buf) continue;
    items.push({ path: rel, size: buf.length, sha1: sha1(buf) });
  }
  return items;
}

async function buildContextSnapshot() {
  const root = PROJECT_ROOT;
  const curated = [
    "server.js", "ai.js", "voice.js", "package.json",
    "apps/amana/telegram.js", "apps/amana/dialogFlows.js",
    "apps/amana/google.js", "apps/amana/memory.js", "apps/amana/toolbox.js",
  ];
  try {
    const dir = await fsp.readdir(path.join(root, "apps/amana"));
    for (const f of dir)
      if (f.endsWith(".js") && !curated.includes(`apps/amana/${f}`))
        curated.push(`apps/amana/${f}`);
  } catch {}
  const files = await collectFiles(root, curated);
  return { snapshot_at: new Date().toISOString(), total_files: files.length, files };
}

async function saveContextToDrive() {
  const auth = await authUserOAuth();
  const folders = await ensureSubfoldersOAuth(auth);
  const snap = await buildContextSnapshot();

  const nameJSON = `SNAPSHOT_${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  const saved = await saveTextFileOAuth(auth, {
    name: nameJSON,
    text: JSON.stringify(snap, null, 2),
    parentId: folders.Arquivos,
    mimeType: "application/json",
  });

  await upsertIndexOAuth(auth, {
    command: "SAVE_CONTEXT",
    data: { into: "Arquivos", file: nameJSON },
    result: { fileId: saved.id, webViewLink: saved.webViewLink, total_files: snap.total_files },
  });

  return { ok: true, fileId: saved.id, webViewLink: saved.webViewLink, total_files: snap.total_files };
}

// ===== Gmail / Calendar / Sheets =====
async function sendEmail({ to, subject, html }) {
  const auth = await authUserOAuth();
  const gmail = google.gmail({ version: "v1", auth });
  const hdr = [
    `To: ${to}`,
    "MIME-Version: 1.0",
    "Content-Type: text/html; charset=UTF-8",
    `Subject: ${subject || "(sem assunto)"}`,
  ].join("\n");
  const raw = Buffer.from(`${hdr}\n\n${html || ""}`).toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const { data } = await gmail.users.messages.send({ userId: "me", requestBody: { raw } });
  await upsertIndexOAuth(auth, { command: "SEND_EMAIL", data: { to, subject }, result: { id: data.id } });
  return { id: data.id };
}

async function showAgenda({ max = 5 } = {}) {
  const auth = await authUserOAuth();
  const calendar = google.calendar({ version: "v3", auth });
  const now = new Date().toISOString();
  const { data } = await calendar.events.list({
    calendarId: "primary", timeMin: now, maxResults: max, singleEvents: true, orderBy: "startTime",
  });
  const events = (data.items || []).map(ev => ({
    summary: ev.summary || "Sem título",
    start: ev.start?.dateTime || ev.start?.date || "?",
  }));
  await upsertIndexOAuth(auth, { command: "SHOW_AGENDA", data: { max }, result: { total: events.length } });
  return events;
}

// ===== Router & CLI =====
async function runOp(cmd, payload = {}) {
  switch ((cmd || "").toUpperCase()) {
    case "SAVE_CONTEXT": return await saveContextToDrive();
    case "SEND_EMAIL":   return await sendEmail(payload);
    case "SHOW_AGENDA":  return await showAgenda(payload);
    default: throw new Error(`Comando desconhecido: ${cmd}`);
  }
}

async function main() {
  try {
    const args = Object.fromEntries(
      process.argv.slice(2).map(a => {
        const [k, ...r] = a.replace(/^--/, "").split("=");
        return [k, r.join("=")];
      })
    );
    const cmd = args.cmd;
    const data = args.data ? JSON.parse(args.data) : {};
    if (!cmd) throw new Error("Use: node apps/amana/toolbox.js --cmd <COMANDO>");
    console.log(chalk.cyan(`\n🧰 Executando ${cmd} ...`));
    const out = await runOp(cmd, data);
    console.log(chalk.green("✅ Resultado:"), JSON.stringify(out, null, 2));
  } catch (e) {
    console.error(chalk.red("❌ Erro:"), e?.message);
  } finally {
    process.exit(0);
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1].endsWith("toolbox.js")) {
  main();
}
