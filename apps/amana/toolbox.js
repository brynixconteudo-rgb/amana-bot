// apps/amana/toolbox.js
// 🧰 Caixa de ferramentas do Amana_BOT — Drive (SA), Gmail/Calendar/Sheets (OAuth) e Snapshot
// - Corrigido upload do Drive para googleapis v131+ (Readable.from)
// - Auto-chdir para a raiz do projeto (não precisa executar a partir da raiz)
// - Suporte robusto de credenciais SA (JSON inline, vars separadas, path, arquivo)

// ===== Imports =====
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import crypto from "crypto";
import chalk from "chalk";
import { Readable } from "stream";
import { fileURLToPath } from "url";
import { google } from "googleapis";

// ===== Caminhos & chdir automático p/ raiz do projeto =====
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// este arquivo está em src/apps/amana/toolbox.js → raiz = ../../
const PROJECT_ROOT = path.resolve(__dirname, "../../");
try { process.chdir(PROJECT_ROOT); } catch { /* ok */ }

// ===== Constantes & ENV =====
const TZ = "America/Sao_Paulo";
const DRIVE_FOLDER_BASE = process.env.DRIVE_FOLDER_BASE;          // pasta base no Drive (ID)
const SHEETS_SPREADSHEET_ID = process.env.SHEETS_SPREADSHEET_ID;  // opcional

// OAuth (usuário real, para Gmail/Calendar/Sheets)
const OAUTH = {
  id: process.env.GOOGLE_OAUTH_CLIENT_ID,
  secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
  refresh: process.env.GOOGLE_OAUTH_REFRESH_TOKEN,
  redirect: "https://developers.google.com/oauthplayground",
};

// ===== Helpers de credencial SA =====
async function readSAKeyJSON() {
  // 1) JSON inline completo
  if (process.env.GOOGLE_SA_KEY_JSON) {
    return JSON.parse(process.env.GOOGLE_SA_KEY_JSON);
  }

  // 2) Campos separados
  const clientEmail = process.env.GOOGLE_SA_CLIENT_EMAIL;
  const privateKeyRaw = process.env.GOOGLE_SA_PRIVATE_KEY;
  if (clientEmail && privateKeyRaw) {
    // PRIVATE_KEY pode vir com \n escapado — normaliza
    const private_key = privateKeyRaw.includes("\\n")
      ? privateKeyRaw.replaceAll("\\n", "\n")
      : privateKeyRaw;
    return {
      type: "service_account",
      client_email: clientEmail,
      private_key,
    };
  }

  // 3) Caminho para arquivo credencial
  const credPath =
    process.env.GOOGLE_APPLICATION_CREDENTIALS
      ? path.resolve(process.env.GOOGLE_APPLICATION_CREDENTIALS)
      : path.resolve(PROJECT_ROOT, "service-account.json");

  const raw = await fsp.readFile(credPath, "utf8");
  return JSON.parse(raw);
}

// ===== Auth =====
async function authUserOAuth() {
  const { id, secret, refresh } = OAUTH;
  if (!id || !secret || !refresh) {
    throw new Error("OAuth ausente. Configure GOOGLE_OAUTH_CLIENT_ID/SECRET/REFRESH_TOKEN.");
  }
  const oauth2 = new google.auth.OAuth2(id, secret, OAUTH.redirect);
  oauth2.setCredentials({ refresh_token: refresh });
  return oauth2;
}

async function authSAForDrive() {
  if (!DRIVE_FOLDER_BASE) throw new Error("DRIVE_FOLDER_BASE ausente (ID da pasta do Drive).");
  const { client_email, private_key } = await readSAKeyJSON();
  if (!client_email || !private_key) throw new Error("Credenciais da Service Account incompletas.");
  const scopes = ["https://www.googleapis.com/auth/drive"];
  const jwt = new google.auth.JWT(client_email, null, private_key, scopes);
  await jwt.authorize();
  return jwt;
}

function driveSA(auth) {
  return google.drive({ version: "v3", auth });
}

// ===== DRIVE (folders / index / salvar arquivo) =====
async function ensureSubfolders(auth) {
  const drive = driveSA(auth);
  const want = ["Arquivos", "Logs", "Memorias", "Relatorios", "Transcricoes"];
  const map = {};
  for (const name of want) {
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

// **CORRIGIDO**: usa Readable.from com v131+
async function saveTextFileSA(auth, { name, text, parentId, mimeType = "text/plain" }) {
  const drive = driveSA(auth);

  const requestBody = {
    name,
    parents: [parentId || DRIVE_FOLDER_BASE],
  };

  const media = {
    mimeType,
    // Readable.from aceita tanto string quanto Buffer; com array evita problemas de .pipe
    body: Readable.from([text ?? ""]),
  };

  const res = await drive.files.create({
    requestBody,
    media,
    fields: "id,name,webViewLink,parents",
  });

  if (!res?.data?.id) throw new Error("Falha ao criar arquivo no Drive (sem ID).");
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
    // baixa o conteúdo atual
    const file = await drive.files.get({ fileId, alt: "media" }, { responseType: "text" });
    try { json = JSON.parse(file.data); } catch { json = { registros: [] }; }
  }

  const hash = crypto.createHash("sha256")
    .update(JSON.stringify({ command, data, result }))
    .digest("hex");

  json.registros.push({
    timestamp: new Date().toISOString(),
    command,
    data,
    result,
    hash,
  });

  const bodyText = JSON.stringify(json, null, 2);
  const media = {
    mimeType: "application/json",
    body: Readable.from([bodyText]),
  };

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
  const root = PROJECT_ROOT;
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

  try {
    const dir = await fsp.readdir(path.join(root, "apps/amana"));
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

// ===== Gmail / Calendar / Sheets (OAuth) =====
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
  await indexUserOp("SEND_EMAIL", { to, subject }, { id: data.id });
  return { id: data.id };
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

async function indexUserOp(command, data, result) {
  try {
    const sa = await authSAForDrive();
    await upsertIndexSA(sa, { command, data, result });
  } catch (e) {
    console.warn("[indexUserOp] Falha ao indexar:", e?.message);
  }
}

// ===== Router =====
async function runOp(cmd, payload = {}) {
  switch ((cmd || "").toUpperCase()) {
    case "SAVE_CONTEXT": return await saveContextToDrive();
    case "SEND_EMAIL":   return await sendEmail(payload);
    case "SHOW_AGENDA":  return await showAgenda(payload);
    default: throw new Error(`Comando desconhecido: ${cmd}`);
  }
}

// ===== CLI =====
async function main() {
  try {
    const args = Object.fromEntries(
      process.argv.slice(2).map(a => {
        const [k, ...r] = a.replace(/^--/, "").split("=");
        return [k, r.join("=")];
      })
    );
    const cmd  = args.cmd;
    const data = args.data ? JSON.parse(args.data) : {};
    if (!cmd) throw new Error("Use: node apps/amana/toolbox.js --cmd <COMANDO> [--data '{...}']");

    // 🔧 garante que está sempre no root do projeto
    const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../..");
    process.chdir(root);

    console.log(chalk.cyan(`\n🧰 Executando ${cmd} ...`));
    const out = await runOp(cmd, data);
    console.log(chalk.green("✅ Resultado:"), JSON.stringify(out, null, 2));
  } catch (e) {
    console.error(chalk.red("❌ Erro:"), e?.message);
  } finally {
    process.exit(0);
  }
}

// executa apenas se chamado diretamente via CLI
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1].endsWith("toolbox.js")) {
  main();
}

if (typeof module !== "undefined") {
  module.exports = { runOp };
}
