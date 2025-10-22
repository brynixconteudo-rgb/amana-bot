// apps/amana/restoreContext.js
// 🧠 Amana – Restore Context (Drive OAuth, Recursive v2.2)
// Agora percorre todas as subpastas de DRIVE_FOLDER_BASE

import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import chalk from "chalk";
import { fileURLToPath } from "url";
import { google } from "googleapis";

// ---------- setup ----------
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
  console.error("❌ ERRO: DRIVE_FOLDER_BASE não configurado.");
  process.exit(1);
}

// ---------- auth ----------
async function authUserOAuth() {
  const oauth2 = new google.auth.OAuth2(OAUTH.id, OAUTH.secret, OAUTH.redirect);
  oauth2.setCredentials({ refresh_token: OAUTH.refresh });
  return oauth2;
}
function driveOAuth(auth) {
  return google.drive({ version: "v3", auth });
}

// ---------- util ----------
function ensureRuntimePath() {
  const p = path.resolve("./_runtime");
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  return p;
}
function pretty(obj) {
  return JSON.stringify(obj, null, 2);
}
function printLastLines(text, n = 10) {
  const lines = text.split(/\r?\n/);
  console.log(chalk.gray("\n— últimas linhas —"));
  console.log(lines.slice(-n).join("\n"));
  console.log(chalk.gray("— fim —\n"));
}

// ---------- lista recursiva ----------
async function listAllFilesRecursively(drive, parentId, depth = 0, maxDepth = 3) {
  if (depth > maxDepth) return [];
  const q = `'${parentId}' in parents and trashed=false`;
  const res = await drive.files.list({
    q,
    fields: "files(id,name,mimeType,modifiedTime,webViewLink,parents)",
    pageSize: 200,
  });

  let files = [];
  for (const f of res.data.files || []) {
    if (f.mimeType === "application/vnd.google-apps.folder") {
      const sub = await listAllFilesRecursively(drive, f.id, depth + 1, maxDepth);
      files = files.concat(sub);
    } else {
      files.push(f);
    }
  }
  return files;
}

// ---------- lista memórias ----------
async function listMemory() {
  const auth = await authUserOAuth();
  const drive = driveOAuth(auth);

  console.log(chalk.gray("🔍 Buscando memórias em todas as subpastas..."));
  const allFiles = await listAllFilesRecursively(drive, DRIVE_FOLDER_BASE);

  const memories = allFiles.filter((f) =>
    /\.(json)$/i.test(f.name) &&
    (/_CONTEXT|_LINK_IMPORT|_CHAT_HISTORY|_SNAPSHOT|AMANA|AEMS/i.test(f.name))
  );

  if (!memories.length) {
    console.log(chalk.yellow("Nenhuma memória encontrada em subpastas."));
    return [];
  }

  const table = memories
    .sort((a, b) => new Date(b.modifiedTime) - new Date(a.modifiedTime))
    .map((f, i) => ({
      index: i,
      id: f.id,
      name: f.name,
      updated: f.modifiedTime,
      link: f.webViewLink || `https://drive.google.com/file/d/${f.id}/view?usp=drivesdk`,
    }));

  console.table(table);
  return table;
}

// ---------- download ----------
async function downloadFileById(fileId) {
  const auth = await authUserOAuth();
  const drive = driveOAuth(auth);
  const res = await drive.files.get({ fileId, alt: "media" }, { responseType: "arraybuffer" });
  return Buffer.from(res.data).toString("utf-8");
}

// ---------- load ----------
async function loadMemory({ id }) {
  const list = await listMemory();
  const target = list.find((f) => f.id === id || f.name.includes(id));
  if (!target) throw new Error(`Arquivo não encontrado: ${id}`);

  const content = await downloadFileById(target.id);
  const json = JSON.parse(content);

  const runtimeDir = ensureRuntimePath();
  const outPath = path.join(runtimeDir, "context_active.json");
  await fsp.writeFile(outPath, pretty(json), "utf-8");

  console.log(chalk.green("✅ Contexto restaurado em:"), outPath);
  printLastLines(pretty(json), 10);
  return { id: target.id, path: outPath, keys: Object.keys(json) };
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

    switch (cmd) {
      case "LIST_MEMORY":
        await listMemory();
        break;
      case "LOAD_MEMORY":
        await loadMemory({ id: args.id });
        break;
      default:
        throw new Error("Use: --cmd=LIST_MEMORY | LOAD_MEMORY");
    }
  } catch (e) {
    console.error(chalk.red("❌ Erro:"), e.message);
  } finally {
    process.exit(0);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();

export { listMemory, loadMemory };
