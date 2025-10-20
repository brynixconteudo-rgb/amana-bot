// apps/amana/restoreContext.js
// 🧠 AEMS Restore — Carrega e reidrata memórias salvas no Drive

import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import chalk from "chalk";
import { google } from "googleapis";
import { Readable } from "stream";
import { fileURLToPath } from "url";

// ==== Setup e utilidades ====
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "../../");
try { process.chdir(PROJECT_ROOT); } catch {}

const DRIVE_FOLDER_BASE = process.env.DRIVE_FOLDER_BASE;

// === Auth SA (Drive) ===
async function readSAKeyJSON() {
  if (process.env.GOOGLE_SA_KEY_JSON) return JSON.parse(process.env.GOOGLE_SA_KEY_JSON);
  const file = process.env.GOOGLE_APPLICATION_CREDENTIALS || "service-account.json";
  return JSON.parse(await fsp.readFile(path.resolve(file), "utf8"));
}

async function authSAForDrive() {
  const { client_email, private_key } = await readSAKeyJSON();
  const scopes = ["https://www.googleapis.com/auth/drive"];
  const jwt = new google.auth.JWT(client_email, null, private_key, scopes);
  await jwt.authorize();
  return jwt;
}

function driveSA(auth) {
  return google.drive({ version: "v3", auth });
}

// === Funções principais ===
async function listMemories() {
  const sa = await authSAForDrive();
  const drive = driveSA(sa);

  const q = [
    `'${DRIVE_FOLDER_BASE}' in parents`,
    "trashed=false",
    "name contains '_CONTEXT.json'",
    "mimeType!='application/vnd.google-apps.folder'"
  ].join(" and ");

  const { data } = await drive.files.list({
    q,
    fields: "files(id,name,modifiedTime,webViewLink)",
    orderBy: "modifiedTime desc"
  });

  const files = (data.files || []).map(f => ({
    id: f.id,
    name: f.name,
    updated: f.modifiedTime,
    link: f.webViewLink
  }));

  if (!files.length) {
    console.log(chalk.yellow("Nenhuma memória encontrada."));
    return [];
  }

  console.table(files);
  return files;
}

async function loadMemory(id) {
  if (!id) throw new Error("ID do arquivo é obrigatório (--id=<ID>).");

  const sa = await authSAForDrive();
  const drive = driveSA(sa);
  const res = await drive.files.get({ fileId: id, alt: "media" }, { responseType: "text" });
  const json = JSON.parse(res.data);
  console.log(chalk.green(`\n✅ Memória carregada: ${json.meta?.project || "sem nome"}`));
  console.log(chalk.cyan(`Arquivos: ${json.state?.files?.length || 0}`));
  console.log(chalk.gray(JSON.stringify(json, null, 2).slice(0, 1500) + "\n..."));
  return json;
}

async function restoreToChat(id) {
  const json = await loadMemory(id);
  const nameBase = json.meta?.project || "RESTORE";
  const basePath = `/tmp/${nameBase}_${Date.now()}`;
  await fsp.mkdir(basePath, { recursive: true });

  const mdPath = `${basePath}/context.md`;
  const txtPath = `${basePath}/context.txt`;

  const fullText = [
    `# Projeto: ${json.meta?.project}`,
    `Data: ${json.meta?.timestamp}`,
    "",
    "## Conversa",
    json.conversation?.map(c => `${c.role.toUpperCase()}: ${c.text}`).join("\n\n") || "(vazio)",
    "",
    "## Estado",
    JSON.stringify(json.state || {}, null, 2)
  ].join("\n");

  await fsp.writeFile(mdPath, fullText);
  await fsp.writeFile(txtPath, fullText);
  console.log(chalk.green(`✅ Memória restaurada localmente em:\n${mdPath}\n${txtPath}`));
  return { mdPath, txtPath };
}

// === Router ===
async function runOp(cmd, args) {
  switch (cmd.toUpperCase()) {
    case "LIST_MEMORY":
      return await listMemories();
    case "LOAD_MEMORY":
      return await loadMemory(args.id);
    case "RESTORE_TO_CHAT":
      return await restoreToChat(args.id);
    default:
      throw new Error(`Comando desconhecido: ${cmd}`);
  }
}

// === CLI ===
async function main() {
  try {
    const args = Object.fromEntries(
      process.argv.slice(2).map(a => {
        const [k, ...r] = a.replace(/^--/, "").split("=");
        return [k, r.join("=")];
      })
    );
    const cmd = args.cmd;
    if (!cmd) throw new Error("Use: node apps/amana/restoreContext.js --cmd=<COMANDO> [--id=<ID>]");

    console.log(chalk.cyan(`\n🧠 Executando ${cmd} ...`));
    const out = await runOp(cmd, args);
    console.log(chalk.green("✅ Concluído."));
    return out;
  } catch (e) {
    console.error(chalk.red("❌ Erro:"), e?.message);
  } finally {
    process.exit(0);
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1].endsWith("restoreContext.js")) {
  main();
}

if (typeof module !== "undefined") {
  module.exports = { runOp };
}
