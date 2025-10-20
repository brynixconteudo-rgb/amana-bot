// apps/amana/memoryManager.js
// 🧠 Amana Extended Memory System (AEMS)
// v1.2 — Correção de listagem (busca robusta da pasta Memorias no Drive)

import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import crypto from "crypto";
import chalk from "chalk";
import { google } from "googleapis";
import { Readable } from "stream";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "../../");

const DRIVE_FOLDER_BASE = process.env.DRIVE_FOLDER_BASE;

// ======= Auth =======
async function authUserOAuth() {
  const id = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const secret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const refresh = process.env.GOOGLE_OAUTH_REFRESH_TOKEN;
  if (!id || !secret || !refresh) throw new Error("OAuth ausente (GOOGLE_OAUTH_*).");
  const oauth2 = new google.auth.OAuth2(id, secret, "https://developers.google.com/oauthplayground");
  oauth2.setCredentials({ refresh_token: refresh });
  return oauth2;
}

function driveUser(auth) {
  return google.drive({ version: "v3", auth });
}

// ======= Helpers =======
function nowISO() { return new Date().toISOString(); }

function schemaMemory(project, contextText, chatTurns = []) {
  return {
    meta: {
      timestamp: nowISO(),
      project,
      author: "Paulo Alessandro",
      assistant: "Amana",
      version: "v1.0",
    },
    state: {
      summary: `Contexto ativo do projeto ${project}`,
      objectives: [],
      key_decisions: [],
    },
    conversation: {
      turns: chatTurns.map(t => ({
        role: t.role || "user",
        message: t.message || "",
      })),
    },
    raw: contextText || "",
  };
}

// ======= DRIVE OPS =======
async function getOrCreateFolder(auth, name) {
  const drive = driveUser(auth);
  const q = [
    `'${DRIVE_FOLDER_BASE}' in parents`,
    "trashed=false",
    "mimeType='application/vnd.google-apps.folder'",
    `name='${name}'`,
  ].join(" and ");
  const { data } = await drive.files.list({ q, fields: "files(id,name)" });
  if (data.files?.length) return data.files[0].id;

  const res = await drive.files.create({
    requestBody: { name, mimeType: "application/vnd.google-apps.folder", parents: [DRIVE_FOLDER_BASE] },
    fields: "id,name",
  });
  return res.data.id;
}

async function saveMemoryFile(auth, project, textJSON) {
  const drive = driveUser(auth);
  const folderId = await getOrCreateFolder(auth, "Memorias");
  const name = `${nowISO().replace(/[:.]/g, "-")}_${project}_CONTEXT.json`;
  const media = { mimeType: "application/json", body: Readable.from([textJSON]) };
  const res = await drive.files.create({
    requestBody: { name, parents: [folderId] },
    media,
    fields: "id,name,webViewLink",
  });
  return res.data;
}

async function listMemories(auth) {
  const drive = driveUser(auth);
  const folderId = await getOrCreateFolder(auth, "Memorias");
  const q = [
    `'${folderId}' in parents`,
    "trashed=false",
    "mimeType='application/json'",
  ].join(" and ");
  const { data } = await drive.files.list({
    q,
    pageSize: 100,
    orderBy: "modifiedTime desc",
    fields: "files(id,name,modifiedTime,webViewLink)",
  });
  return data.files || [];
}

async function loadMemory(auth, fileId) {
  const drive = driveUser(auth);
  const { data } = await drive.files.get({ fileId, alt: "media" });
  return JSON.parse(data);
}

// ======= CORE OPS =======
export async function saveMemory(project, contextText, chatTurns) {
  const auth = await authUserOAuth();
  const json = schemaMemory(project, contextText, chatTurns);
  const saved = await saveMemoryFile(auth, project, JSON.stringify(json, null, 2));
  console.log(chalk.green(`🧠 Memória salva:`), saved.webViewLink);
  return saved;
}

export async function listAllMemories() {
  const auth = await authUserOAuth();
  const list = await listMemories(auth);
  if (!list.length) {
    console.log(chalk.yellow("⚠️ Nenhuma memória encontrada na pasta 'Memorias'."));
  } else {
    console.table(list.map(f => ({
      id: f.id,
      name: f.name,
      updated: f.modifiedTime,
      link: f.webViewLink,
    })));
  }
  return list;
}

export async function loadMemoryById(fileId) {
  const auth = await authUserOAuth();
  const data = await loadMemory(auth, fileId);
  console.log(chalk.cyan(`📖 Memória carregada:`));
  console.log(JSON.stringify(data, null, 2));
  return data;
}

// ======= CLI =======
async function main() {
  const args = Object.fromEntries(process.argv.slice(2).map(a => {
    const [k, ...r] = a.replace(/^--/, "").split("=");
    return [k, r.join("=")];
  }));

  const cmd = (args.cmd || "").toUpperCase();
  const project = args.project || "Amana_BOT";

  try {
    switch (cmd) {
      case "SAVE_MEMORY":
        const contextText = args.text || "Memória de teste";
        await saveMemory(project, contextText, []);
        break;
      case "LIST_MEMORY":
        await listAllMemories();
        break;
      case "LOAD_MEMORY":
        if (!args.id) throw new Error("Passe --id=<fileId>");
        await loadMemoryById(args.id);
        break;
      default:
        console.log("Use: --cmd=SAVE_MEMORY|LIST_MEMORY|LOAD_MEMORY");
    }
  } catch (e) {
    console.error(chalk.red("❌ Erro:"), e?.message);
  } finally {
    process.exit(0);
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1].endsWith("memoryManager.js")) {
  main();
}
