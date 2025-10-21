// apps/amana/memoryIndex.js
// 🧠 Amana Memory Index Manager (v3)
// Compatível com contas pessoais (OAuth) e integração com memoryManager.
// - Adiciona campo "origin" (manual/auto)
// - Ordena listagem por data (mais recente primeiro)
// - Melhora mensagens e logs
// - Remove dependência de Service Account

import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import chalk from "chalk";
import crypto from "crypto";
import { Readable } from "stream";
import { google } from "googleapis";

// ========================= CONFIG =========================
const DRIVE_FOLDER_BASE = process.env.DRIVE_FOLDER_BASE;

const OAUTH = {
  id: process.env.GOOGLE_OAUTH_CLIENT_ID,
  secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
  refresh: process.env.GOOGLE_OAUTH_REFRESH_TOKEN,
  redirect: "https://developers.google.com/oauthplayground",
};

if (!DRIVE_FOLDER_BASE) {
  console.error("❌ ERRO: DRIVE_FOLDER_BASE não configurado.");
  process.exit(1);
}

// ========================= AUTH =========================
async function authUserOAuth() {
  const { id, secret, refresh } = OAUTH;
  if (!id || !secret || !refresh)
    throw new Error("OAuth ausente (GOOGLE_OAUTH_CLIENT_ID/SECRET/REFRESH_TOKEN).");

  const oauth2 = new google.auth.OAuth2(id, secret, OAUTH.redirect);
  oauth2.setCredentials({ refresh_token: refresh });
  return oauth2;
}

function driveOAuth(auth) {
  return google.drive({ version: "v3", auth });
}

// ========================= DRIVE HELPERS =========================
async function getIndexFile(auth) {
  const drive = driveOAuth(auth);
  const q = [
    `'${DRIVE_FOLDER_BASE}' in parents`,
    "trashed=false",
    "name='Amana_INDEX.json'",
  ].join(" and ");
  const { data } = await drive.files.list({ q, fields: "files(id,name)" });
  return data.files?.[0] || null;
}

async function readIndexJSON(auth) {
  const drive = driveOAuth(auth);
  const file = await getIndexFile(auth);
  if (!file) return [];

  try {
    const res = await drive.files.get({ fileId: file.id, alt: "media" }, { responseType: "text" });
    const data = JSON.parse(res.data);
    return Array.isArray(data)
      ? data
      : Array.isArray(data.records)
      ? data.records
      : [];
  } catch {
    return [];
  }
}

async function writeIndexJSON(auth, json) {
  const drive = driveOAuth(auth);
  const body = JSON.stringify(json, null, 2);
  const media = { mimeType: "application/json", body: Readable.from([body]) };
  const file = await getIndexFile(auth);

  if (file) {
    await drive.files.update({ fileId: file.id, media });
    return file.id;
  } else {
    const res = await drive.files.create({
      requestBody: {
        name: "Amana_INDEX.json",
        parents: [DRIVE_FOLDER_BASE],
        mimeType: "application/json",
      },
      media,
      fields: "id",
    });
    return res.data.id;
  }
}

// ========================= MAIN OPS =========================
async function addToIndex({ project, title, link, size, tags = [], type = "CONTEXT", origin = "manual" }) {
  const auth = await authUserOAuth();
  let index = await readIndexJSON(auth);
  if (!Array.isArray(index)) index = [];

  const idMatch = /\/d\/([^/]+)/.exec(link);
  const id = idMatch ? idMatch[1] : crypto.randomBytes(6).toString("hex");

  const entry = {
    id,
    project,
    type,
    origin, // <-- novo campo
    title,
    link,
    size: size || "unknown",
    tags,
    timestamp: new Date().toISOString(),
  };

  index.push(entry);
  index.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)); // mais recente primeiro

  await writeIndexJSON(auth, index);

  console.log(chalk.green("🧩 Índice atualizado:"), chalk.cyan(project), "→", chalk.yellow(title));
  return entry;
}

async function listIndex() {
  const auth = await authUserOAuth();
  let index = await readIndexJSON(auth);
  if (!Array.isArray(index)) index = [];
  index.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  if (!index.length) {
    console.log(chalk.yellow("Nenhum registro no índice global."));
    return [];
  }

  console.table(
    index.map((i) => ({
      project: i.project,
      title: i.title,
      origin: i.origin || "-",
      timestamp: i.timestamp,
      link: i.link,
    }))
  );
  return index;
}

async function getProjectIndex(project) {
  const auth = await authUserOAuth();
  let index = await readIndexJSON(auth);
  if (!Array.isArray(index)) index = [];

  const filtered = index.filter((i) => i.project === project);
  filtered.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  if (!filtered.length) {
    console.log(chalk.yellow(`Nenhum registro encontrado para o projeto '${project}'.`));
    return [];
  }

  console.table(
    filtered.map((i) => ({
      title: i.title,
      origin: i.origin || "-",
      timestamp: i.timestamp,
      link: i.link,
    }))
  );
  return filtered;
}

// ========================= CLI =========================
async function main() {
  try {
    const args = Object.fromEntries(
      process.argv.slice(2).map((a) => {
        const [k, ...r] = a.replace(/^--/, "").split("=");
        return [k, r.join("=")];
      })
    );

    const cmd = args.cmd?.toUpperCase();
    if (!cmd)
      throw new Error("Use: node apps/amana/memoryIndex.js --cmd=<ADD_INDEX|LIST_INDEX|GET_PROJECT_INDEX>");

    switch (cmd) {
      case "ADD_INDEX":
        await addToIndex({
          project: args.project || "UNKNOWN",
          title: args.title || "Sem título",
          link: args.link,
          tags: args.tags ? args.tags.split(",") : [],
          size: args.size,
          origin: args.origin || "manual",
        });
        break;

      case "LIST_INDEX":
        await listIndex();
        break;

      case "GET_PROJECT_INDEX":
        await getProjectIndex(args.project);
        break;

      default:
        throw new Error(`Comando inválido: ${cmd}`);
    }
  } catch (e) {
    console.error(chalk.red("❌ Erro:"), e.message);
  } finally {
    process.exit(0);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();

export { addToIndex, listIndex, getProjectIndex };
