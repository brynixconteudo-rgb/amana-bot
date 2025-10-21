// apps/amana/memoryManager.js
// 🧠 Gerencia memórias estendidas (salvar, listar, auto-indexar)

import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import chalk from "chalk";
import { google } from "googleapis";
import { Readable } from "stream";

// === CONFIG ===
const DRIVE_FOLDER_BASE = process.env.DRIVE_FOLDER_BASE;
const PROJECT_FOLDER = "Memorias";
const TZ = "America/Sao_Paulo";

// === AUTH SERVICE ACCOUNT ===
async function readSAKeyJSON() {
  const jsonRaw = process.env.GOOGLE_SA_KEY_JSON || await fsp.readFile("service-account.json", "utf8");
  return JSON.parse(jsonRaw);
}

async function authSA() {
  const { client_email, private_key } = await readSAKeyJSON();
  const jwt = new google.auth.JWT(client_email, null, private_key, ["https://www.googleapis.com/auth/drive"]);
  await jwt.authorize();
  return jwt;
}

function drive(auth) {
  return google.drive({ version: "v3", auth });
}

// === DRIVE OPS ===
async function ensureFolder(auth, name) {
  const driveAPI = drive(auth);
  const q = [
    `'${DRIVE_FOLDER_BASE}' in parents`,
    `name='${name}'`,
    "mimeType='application/vnd.google-apps.folder'",
    "trashed=false"
  ].join(" and ");
  const { data } = await driveAPI.files.list({ q, fields: "files(id)" });
  if (data.files?.length) return data.files[0].id;

  const folder = await driveAPI.files.create({
    requestBody: {
      name,
      mimeType: "application/vnd.google-apps.folder",
      parents: [DRIVE_FOLDER_BASE],
    },
    fields: "id",
  });
  return folder.data.id;
}

async function saveTextFile(auth, { name, text, parentId, mimeType = "application/json" }) {
  const driveAPI = drive(auth);
  const res = await driveAPI.files.create({
    requestBody: { name, parents: [parentId] },
    media: { mimeType, body: Readable.from([text]) },
    fields: "id,name,webViewLink,modifiedTime",
  });
  return res.data;
}

// === INDEX GLOBAL OPS ===
async function updateGlobalIndex(auth, { project, title, link }) {
  const driveAPI = drive(auth);
  const indexName = "Amana_INDEX.json";
  const q = [
    `'${DRIVE_FOLDER_BASE}' in parents`,
    `name='${indexName}'`,
    "mimeType!='application/vnd.google-apps.folder'",
    "trashed=false"
  ].join(" and ");
  const search = await driveAPI.files.list({ q, fields: "files(id,name)" });

  let fileId = null;
  let index = [];

  if (search.data.files?.length) {
    fileId = search.data.files[0].id;
    const file = await driveAPI.files.get({ fileId, alt: "media" }, { responseType: "text" });
    try { index = JSON.parse(file.data); } catch { index = []; }
  }

  if (!Array.isArray(index)) index = [];

  index.push({
    project,
    title,
    timestamp: new Date().toISOString(),
    link
  });

  const body = JSON.stringify(index, null, 2);
  const media = { mimeType: "application/json", body: Readable.from([body]) };

  if (fileId) {
    await driveAPI.files.update({ fileId, media });
  } else {
    await driveAPI.files.create({
      requestBody: { name: indexName, parents: [DRIVE_FOLDER_BASE], mimeType: "application/json" },
      media,
    });
  }
  console.log(chalk.gray(`🔗 Índice global atualizado com: ${project}`));
}

// === COMANDOS ===
async function saveMemory({ project, text }) {
  const auth = await authSA();
  const folderId = await ensureFolder(auth, PROJECT_FOLDER);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const name = `${timestamp}_${project}_CONTEXT.json`;

  const json = { project, saved_at: new Date().toISOString(), text };
  const saved = await saveTextFile(auth, { name, text: JSON.stringify(json, null, 2), parentId: folderId });

  // auto-indexação global
  await updateGlobalIndex(auth, {
    project,
    title: `Contexto salvo em ${timestamp}`,
    link: saved.webViewLink
  });

  console.log(chalk.green(`🧠 Memória salva: ${saved.webViewLink}`));
}

async function listMemory() {
  const auth = await authSA();
  const driveAPI = drive(auth);
  const q = [
    `'${DRIVE_FOLDER_BASE}' in parents`,
    "mimeType='application/vnd.google-apps.folder'",
    "trashed=false"
  ].join(" and ");
  const { data } = await driveAPI.files.list({ q, fields: "files(id,name)" });
  const folder = data.files.find(f => f.name === PROJECT_FOLDER);
  if (!folder) return console.log("Nenhuma memória encontrada.");
  const list = await driveAPI.files.list({
    q: `'${folder.id}' in parents and trashed=false`,
    fields: "files(id,name,modifiedTime,webViewLink)",
  });
  console.table(list.data.files.map(f => ({
    id: f.id,
    name: f.name,
    updated: f.modifiedTime,
    link: f.webViewLink
  })));
}

// === CLI ===
async function main() {
  const args = Object.fromEntries(process.argv.slice(2).map(a => {
    const [k, ...r] = a.replace(/^--/, "").split("=");
    return [k, r.join("=")];
  }));

  const cmd = args.cmd;
  if (!cmd) throw new Error("Use: node apps/amana/memoryManager.js --cmd=<COMANDO>");

  switch (cmd.toUpperCase()) {
    case "SAVE_MEMORY":
      await saveMemory({ project: args.project, text: args.text });
      break;
    case "LIST_MEMORY":
      await listMemory();
      break;
    default:
      console.error(chalk.red("❌ Comando desconhecido."));
  }
}

if (process.argv[1].endsWith("memoryManager.js")) main();
