// apps/amana/toolbox.js
// 🧰 Caixa de ferramentas do Amana_BOT (versão corrigida 2025-10-20)
// - Drive (Service Account): salvar arquivos, listar, garantir pastas, indexar
// - Gmail/Calendar/Sheets (OAuth do usuário): e-mail, agenda, memórias

import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import crypto from "crypto";
import { google } from "googleapis";
import { Readable } from "stream";

const TZ = "America/Sao_Paulo";
const DRIVE_FOLDER_BASE = process.env.DRIVE_FOLDER_BASE;
const SHEETS_SPREADSHEET_ID = process.env.SHEETS_SPREADSHEET_ID;

const OAUTH = {
  id: process.env.GOOGLE_OAUTH_CLIENT_ID,
  secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
  refresh: process.env.GOOGLE_OAUTH_REFRESH_TOKEN,
  redirect: "https://developers.google.com/oauthplayground",
};

// ---------------------------------------------------------------------------
// 🔐 Autenticação
async function readSAKeyJSON() {
  if (process.env.GOOGLE_SA_KEY_JSON) return JSON.parse(process.env.GOOGLE_SA_KEY_JSON);
  const p = path.resolve("service-account.json");
  return JSON.parse(await fsp.readFile(p, "utf8"));
}

async function authSAForDrive() {
  if (!DRIVE_FOLDER_BASE) throw new Error("DRIVE_FOLDER_BASE ausente (ID da pasta).");
  const { client_email, private_key } = await readSAKeyJSON();
  const scopes = ["https://www.googleapis.com/auth/drive"];
  const jwt = new google.auth.JWT(client_email, null, private_key, scopes);
  await jwt.authorize();
  return jwt;
}

async function authUserOAuth() {
  if (!OAUTH.id || !OAUTH.secret || !OAUTH.refresh)
    throw new Error("OAuth ausente (GOOGLE_OAUTH_CLIENT_ID/SECRET/REFRESH_TOKEN).");
  const oauth2 = new google.auth.OAuth2(OAUTH.id, OAUTH.secret, OAUTH.redirect);
  oauth2.setCredentials({ refresh_token: OAUTH.refresh });
  return oauth2;
}

// ---------------------------------------------------------------------------
// ☁️ DRIVE helpers
function driveSA(auth) {
  return google.drive({ version: "v3", auth });
}

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
    if (data.files?.length) map[name] = data.files[0].id;
    else {
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
// ---------- salvar arquivo no Drive com Service Account ----------
async function saveTextFileSA(auth, { name, text, parentId, mimeType = "text/plain" }) {
  const drive = driveSA(auth);
  const { Readable } = await import("stream");

  // converte o texto em stream (forma segura e compatível com API do Drive)
  const media = {
    mimeType,
    body: Readable.from([text || ""])
  };

  // cria o arquivo
  const res = await drive.files.create({
    requestBody: {
      name,
      parents: [parentId || DRIVE_FOLDER_BASE]
    },
    media,
    fields: "id,name,webViewLink,parents"
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
    const file = await drive.files.get({ fileId, alt: "media" });
    try { json = JSON.parse(file.data); } catch { json = { registros: [] }; }
  }

  const hash = crypto.createHash("sha256").update(JSON.stringify({ command, data, result })).digest("hex");
  json.registros.push({ timestamp: new Date().toISOString(), command, data, result, hash });
  const body = Buffer.from(JSON.stringify(json, null, 2), "utf-8");

  if (fileId) {
    await drive.files.update({ fileId, media: { mimeType: "application/json", body } });
  } else {
    const created = await drive.files.create({
      requestBody: { name: indexName, parents: [DRIVE_FOLDER_BASE], mimeType: "application/json" },
      media: { mimeType: "application/json", body },
      fields: "id",
    });
    fileId = created.data.id;
  }
  return { status: "indexed", fileId, total: json.registros.length };
}

// ---------------------------------------------------------------------------
// 📋 LISTAGEM (fix: sem emailAddress)
async function listDriveHere() {
  const sa = await authSAForDrive();
  const drive = driveSA(sa);
  const q = [`'${DRIVE_FOLDER_BASE}' in parents`, "trashed=false"].join(" and ");
  const { data } = await drive.files.list({
    q,
    pageSize: 100,
    fields: "files(id,name,mimeType,modifiedTime,owners(displayName))",
  });
  return data.files?.map(f => ({
    id: f.id,
    name: f.name,
    mimeType: f.mimeType,
    modifiedTime: f.modifiedTime,
  })) || [];
}

// ---------------------------------------------------------------------------
// 🧠 SNAPSHOT / CONTEXTO
function sha1(buf) { return crypto.createHash("sha1").update(buf).digest("hex"); }
async function readIfExists(abs) { try { return await fsp.readFile(abs); } catch { return null; } }

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
  const root = path.resolve(".");
  const curated = [
    "server.js",
    "ai.js",
    "package.json",
    "apps/amana/toolbox.js",
    "apps/amana/google.js",
    "apps/amana/memory.js",
    "apps/amana/dialogFlows.js",
  ];
  const files = await collectFiles(root, curated);
  return { snapshot_at: new Date().toISOString(), total_files: files.length, files };
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

// ---------------------------------------------------------------------------
// 🧩 Roteador principal
export async function runOp(cmd, payload = {}) {
  switch ((cmd || "").toUpperCase()) {
    case "SAVE_CONTEXT": return await saveContextToDrive();
    case "LIST_DRIVE_HERE": return await listDriveHere();
    default: throw new Error(`Comando desconhecido: ${cmd}`);
  }
}

// ---------------------------------------------------------------------------
// 🖥️ CLI
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
