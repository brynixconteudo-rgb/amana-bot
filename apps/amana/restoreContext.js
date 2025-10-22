// apps/amana/restoreContext.js
// 🧠 Amana – Restore Context (Drive OAuth)
// - Agora faz varredura real em subpastas de DRIVE_FOLDER_BASE
// - Lista e carrega memórias *_CONTEXT.json, mesmo que estejam em pastas aninhadas
// - Integra com Amana_INDEX.json e salva contexto ativo em _runtime/context_active.json

import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import chalk from "chalk";
import { fileURLToPath } from "url";
import { google } from "googleapis";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "../../");
try { process.chdir(PROJECT_ROOT); } catch {}

const DRIVE_FOLDER_BASE = process.env.DRIVE_FOLDER_BASE;
const OAUTH = {
  id: process.env.GOOGLE_OAUTH_CLIENT_ID,
  secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
  refresh: process.env.GOOGLE_OAUTH_REFRESH_TOKEN,
  redirect: "https://developers.google.com/oauthplayground",
};

if (!DRIVE_FOLDER_BASE) {
  console.error(chalk.red("❌ ERRO: DRIVE_FOLDER_BASE não configurado."));
  process.exit(1);
}
if (!OAUTH.id || !OAUTH.secret || !OAUTH.refresh) {
  console.error(chalk.red("❌ ERRO: OAuth ausente (GOOGLE_OAUTH_CLIENT_ID/SECRET/REFRESH_TOKEN)."));
  process.exit(1);
}

async function authUserOAuth() {
  const oauth2 = new google.auth.OAuth2(OAUTH.id, OAUTH.secret, OAUTH.redirect);
  oauth2.setCredentials({ refresh_token: OAUTH.refresh });
  return oauth2;
}
function driveOAuth(auth) {
  return google.drive({ version: "v3", auth });
}

function ensureRuntimePath() {
  const p = path.resolve("./_runtime");
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  return p;
}
function pretty(obj) { return JSON.stringify(obj, null, 2); }
function printLastLines(text, n = 10) {
  const lines = text.split(/\r?\n/);
  const slice = lines.slice(Math.max(0, lines.length - n));
  console.log(chalk.gray("\n— últimas linhas —"));
  console.log(slice.join("\n"));
  console.log(chalk.gray("— fim —\n"));
}

// ---------- VARREDURA RECURSIVA DE PASTAS ----------
async function getAllFolderIds(drive, rootId) {
  const allIds = [rootId];
  const queue = [rootId];

  while (queue.length) {
    const parent = queue.shift();
    const q = [
      `'${parent}' in parents`,
      "trashed=false",
      "mimeType='application/vnd.google-apps.folder'",
    ].join(" and ");
    const { data } = await drive.files.list({ q, fields: "files(id,name)" });
    if (data.files?.length) {
      for (const f of data.files) {
        allIds.push(f.id);
        queue.push(f.id);
      }
    }
  }
  return allIds;
}

// ---------- LIST_MEMORY ----------
async function listMemory() {
  const auth = await authUserOAuth();
  const drive = driveOAuth(auth);

  const folderIds = await getAllFolderIds(drive, DRIVE_FOLDER_BASE);
  const allFiles = [];

  for (const folderId of folderIds) {
    const q = [
      `'${folderId}' in parents`,
      "trashed=false",
      "name contains '_CONTEXT.json'",
      "mimeType!='application/vnd.google-apps.folder'",
    ].join(" and ");
    try {
      const { data } = await drive.files.list({
        q,
        fields: "files(id,name,modifiedTime,webViewLink,parents)",
        orderBy: "modifiedTime desc",
      });
      if (data.files?.length) allFiles.push(...data.files);
    } catch (err) {
      console.warn(`⚠️ Falha ao buscar em ${folderId}:`, err.message);
    }
  }

  if (!allFiles.length) {
    console.log(chalk.yellow("Nenhuma memória encontrada (nem em subpastas)."));
    return [];
  }

  const files = allFiles
    .map((f) => ({
      id: f.id,
      name: f.name,
      updated: f.modifiedTime,
      link: f.webViewLink || `https://drive.google.com/file/d/${f.id}/view?usp=drivesdk`,
    }))
    .sort((a, b) => new Date(b.updated) - new Date(a.updated));

  console.table(
    files.map((f, idx) => ({
      index: idx,
      id: f.id,
      name: f.name,
      updated: f.updated,
      link: f.link,
    }))
  );

  return files;
}

// ---------- DOWNLOAD ----------
async function downloadFileById(fileId) {
  const auth = await authUserOAuth();
  const drive = driveOAuth(auth);
  const res = await drive.files.get({ fileId, alt: "media" }, { responseType: "arraybuffer" });
  return Buffer.from(res.data).toString("utf-8");
}

// ---------- RESOLVE ID ----------
async function resolveMemoryId(idOrName) {
  const list = await listMemory();
  if (!list.length) throw new Error("Não há memórias para carregar.");
  if (/^\d+$/.test(idOrName)) {
    const idx = parseInt(idOrName, 10);
    if (idx < 0 || idx >= list.length) throw new Error(`Índice fora do intervalo: ${idx}`);
    return list[idx].id;
  }
  const exact = list.find((f) => f.id === idOrName);
  if (exact) return exact.id;
  const lower = idOrName.toLowerCase();
  const byName = list.filter((f) => f.name.toLowerCase().includes(lower));
  if (byName.length === 1) return byName[0].id;
  if (byName.length > 1) {
    console.table(byName.map((f, i) => ({ index: i, id: f.id, name: f.name, updated: f.updated })));
    throw new Error("Seja mais específico (use o ID completo ou um índice).");
  }
  throw new Error(`Memória não encontrada: ${idOrName}`);
}

// ---------- LOAD_MEMORY ----------
async function loadMemory({ id }) {
  if (!id) throw new Error("Informe --id=<driveId|#index|nome-parcial>");
  const fileId = await resolveMemoryId(id);
  const content = await downloadFileById(fileId);

  let json;
  try { json = JSON.parse(content); }
  catch { throw new Error("Arquivo baixado não é um JSON válido."); }

  const runtimeDir = ensureRuntimePath();
  const outPath = path.join(runtimeDir, "context_active.json");
  await fsp.writeFile(outPath, pretty(json), "utf-8");

  console.log(chalk.green("✅ Contexto restaurado em:"), outPath);
  printLastLines(pretty(json), 10);

  const stats = {
    saved_to: outPath,
    keys: Object.keys(json),
    snapshot_at: json.snapshot_at || null,
    total_files: json.total_files || (Array.isArray(json.files) ? json.files.length : undefined),
  };
  console.log(chalk.cyan("ℹ️ Metadados:"), stats);
  return stats;
}

// ---------- ÍNDICE GLOBAL ----------
async function readGlobalIndex() {
  const auth = await authUserOAuth();
  const drive = driveOAuth(auth);
  const q = [
    `'${DRIVE_FOLDER_BASE}' in parents`,
    "trashed=false",
    "name='Amana_INDEX.json'",
  ].join(" and ");
  const { data } = await drive.files.list({ q, fields: "files(id,name)" });
  const file = data.files?.[0];
  if (!file) return [];
  try {
    const res = await drive.files.get({ fileId: file.id, alt: "media" }, { responseType: "text" });
    const json = JSON.parse(res.data);
    return Array.isArray(json) ? json : json.records || [];
  } catch { return []; }
}

// ---------- LIST_PROJECTS ----------
async function listProjects() {
  const index = await readGlobalIndex();
  if (!index.length) {
    console.log(chalk.yellow("Nenhum registro no índice global."));
    return [];
  }
  const projects = [...new Set(index.map((e) => e.project).filter(Boolean))];
  if (!projects.length) {
    console.log(chalk.yellow("Índice presente, mas sem campo 'project'."));
    return [];
  }
  console.table(projects.map((p, i) => ({ index: i, project: p })));
  return projects;
}

// ---------- LOAD_PROJECT ----------
async function loadProject({ project }) {
  if (!project) throw new Error("Informe --project=\"NOME_DO_PROJETO\"");
  const index = await readGlobalIndex();
  const rows = index
    .filter((e) => e.project === project)
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  if (!rows.length) throw new Error(`Projeto '${project}' não encontrado no índice.`);
  const last = rows[0];
  const link = last.link || "";
  const m = /\/d\/([^/]+)/.exec(link);
  const fileId = m ? m[1] : last.id;
  if (!fileId) throw new Error("Registro no índice não contém ID nem link válido.");
  console.log(chalk.cyan(`↪ Carregando memória mais recente de '${project}':`), last.title);
  return await loadMemory({ id: fileId });
}

// ---------- CLI ----------
async function main() {
  try {
    const args = Object.fromEntries(
      process.argv.slice(2).map((a) => {
        const [k, ...r] = a.replace(/^--/, "").split("=");
        return [k, r.join("=")];
      })
    );
    const cmd = (args.cmd || "").toUpperCase();
    if (!cmd) throw new Error("Use: --cmd=LIST_MEMORY|LOAD_MEMORY|LIST_PROJECTS|LOAD_PROJECT");
    switch (cmd) {
      case "LIST_MEMORY": await listMemory(); break;
      case "LOAD_MEMORY": await loadMemory({ id: args.id }); break;
      case "LIST_PROJECTS": await listProjects(); break;
      case "LOAD_PROJECT": await loadProject({ project: args.project }); break;
      default: throw new Error(`Comando inválido: ${cmd}`);
    }
  } catch (e) {
    console.error(chalk.red("❌ Erro:"), e.message);
  } finally { process.exit(0); }
}
if (import.meta.url === `file://${process.argv[1]}`) main();

export { listMemory, loadMemory, listProjects, loadProject };
