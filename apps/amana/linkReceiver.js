// apps/amana/linkReceiver.js
// 🌐 Amana Link Receiver — converte links compartilhados (ChatGPT, docs, etc.) em memórias estendidas
//
// Fluxo:
//   1. Recebe um link compartilhado (ChatGPT ou outro conteúdo público).
//   2. Faz o download do conteúdo bruto (HTML ou texto).
//   3. Extrai título, corpo e metadados.
//   4. Cria um snapshot JSON padronizado.
//   5. Envia para o Drive e atualiza o índice global.
//
// CLI:
//   node apps/amana/linkReceiver.js --cmd=IMPORT_LINK --project="FATOS_DO_MUNDO" --url="https://chat.openai.com/share/xxx"
//
// Requisitos ENV (OAuth):
//   DRIVE_FOLDER_BASE=...
//   GOOGLE_OAUTH_CLIENT_ID=...
//   GOOGLE_OAUTH_CLIENT_SECRET=...
//   GOOGLE_OAUTH_REFRESH_TOKEN=...

import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import chalk from "chalk";
import { Readable } from "stream";
import fetch from "node-fetch";
import { google } from "googleapis";
import { fileURLToPath } from "url";
import crypto from "crypto";

// ========== Inicialização ==========
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "../../");
try { process.chdir(PROJECT_ROOT); } catch {}

// ========== Configurações ==========
const DRIVE_FOLDER_BASE = process.env.DRIVE_FOLDER_BASE;
const OAUTH = {
  id: process.env.GOOGLE_OAUTH_CLIENT_ID,
  secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
  refresh: process.env.GOOGLE_OAUTH_REFRESH_TOKEN,
  redirect: "https://developers.google.com/oauthplayground",
};

if (!DRIVE_FOLDER_BASE) throw new Error("❌ DRIVE_FOLDER_BASE não configurado.");

// ========== Autenticação ==========
async function authUserOAuth() {
  const { id, secret, refresh } = OAUTH;
  if (!id || !secret || !refresh)
    throw new Error("OAuth ausente (GOOGLE_OAUTH_CLIENT_ID/SECRET/REFRESH_TOKEN).");
  const oauth2 = new google.auth.OAuth2(id, secret, OAUTH.redirect);
  oauth2.setCredentials({ refresh_token: refresh });
  return oauth2;
}
function driveOAuth(auth) { return google.drive({ version: "v3", auth }); }

// ========== Helper: salvar JSON no Drive ==========
async function saveJSONtoDrive(auth, { name, data, parentId = DRIVE_FOLDER_BASE }) {
  const drive = driveOAuth(auth);
  const jsonText = JSON.stringify(data, null, 2);
  const media = { mimeType: "application/json", body: Readable.from([jsonText]) };
  const res = await drive.files.create({
    requestBody: { name, parents: [parentId], mimeType: "application/json" },
    media,
    fields: "id,name,webViewLink",
  });
  return res.data;
}

// ========== Helper: atualizar índice global ==========
async function updateIndex(auth, { project, title, link, fileId }) {
  const drive = driveOAuth(auth);
  const q = [
    `'${DRIVE_FOLDER_BASE}' in parents`,
    "trashed=false",
    "name='Amana_INDEX.json'",
  ].join(" and ");
  const { data } = await drive.files.list({ q, fields: "files(id,name)" });

  let index = [];
  let fileIdIndex = null;

  if (data.files?.length) {
    fileIdIndex = data.files[0].id;
    const res = await drive.files.get({ fileId: fileIdIndex, alt: "media" }, { responseType: "text" });
    try { index = JSON.parse(res.data); } catch { index = []; }
  }

  const entry = {
    id: fileId,
    project,
    title,
    link,
    timestamp: new Date().toISOString(),
    tags: ["link", "import"],
  };

  index.push(entry);
  const jsonBody = JSON.stringify(index, null, 2);

  const media = { mimeType: "application/json", body: Readable.from([jsonBody]) };
  if (fileIdIndex) {
    await drive.files.update({ fileId: fileIdIndex, media });
  } else {
    await drive.files.create({
      requestBody: { name: "Amana_INDEX.json", parents: [DRIVE_FOLDER_BASE], mimeType: "application/json" },
      media,
    });
  }
  console.log(chalk.green(`📚 Índice global atualizado com entrada de ${project}`));
}

// ========== Extrator simples ==========
async function fetchAndExtract(url) {
  console.log(chalk.cyan(`🌐 Baixando conteúdo de:`), url);
  const res = await fetch(url);
  const html = await res.text();

  // Extrai título e corpo básico (modo genérico)
  const title = html.match(/<title>(.*?)<\/title>/i)?.[1] || "Sem título";
  const textContent = html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 10000); // limita a 10k chars pra não estourar

  return { title, html, textContent };
}

// ========== Criador de Snapshot ==========
function buildSnapshot({ project, title, url, textContent }) {
  return {
    meta: {
      project,
      imported_from: url,
      imported_at: new Date().toISOString(),
      type: "link_import",
    },
    content: {
      title,
      text: textContent,
    },
  };
}

// ========== Operação Principal ==========
async function importLink({ project, url }) {
  if (!url) throw new Error("Informe --url=<link>");
  if (!project) throw new Error("Informe --project=<nome_projeto>");

  const auth = await authUserOAuth();
  const { title, textContent } = await fetchAndExtract(url);
  const snapshot = buildSnapshot({ project, title, url, textContent });

  const name = `${new Date().toISOString().replace(/[:.]/g, "-")}_${project}_LINK_IMPORT.json`;
  const saved = await saveJSONtoDrive(auth, { name, data: snapshot });

  await updateIndex(auth, { project, title, link: url, fileId: saved.id });

  console.log(chalk.green(`✅ Snapshot salvo:`), saved.webViewLink);
  return saved;
}

// ========== CLI ==========
async function main() {
  try {
    const args = Object.fromEntries(
      process.argv.slice(2).map(a => {
        const [k, ...r] = a.replace(/^--/, "").split("=");
        return [k, r.join("=")];
      })
    );
    const cmd = (args.cmd || "").toUpperCase();
    switch (cmd) {
      case "IMPORT_LINK":
        await importLink({ project: args.project, url: args.url });
        break;
      default:
        console.log("Use: --cmd=IMPORT_LINK --project=\"NOME\" --url=\"LINK\"");
    }
  } catch (e) {
    console.error(chalk.red("❌ Erro:"), e.message);
  } finally {
    process.exit(0);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
export { importLink };
