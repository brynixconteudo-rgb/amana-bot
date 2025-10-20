// 🧠 Amana RestoreContext — leitura e restauração de memórias do Drive
// Compatível com memoryManager.js (usa subpasta "Memorias")

import { google } from "googleapis";
import chalk from "chalk";
import path from "path";
import { fileURLToPath } from "url";

// ===== Caminho raiz e chdir automático =====
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "../../");
try { process.chdir(PROJECT_ROOT); } catch {}

// ===== ENV =====
const DRIVE_FOLDER_BASE = process.env.DRIVE_FOLDER_BASE;
const GOOGLE_SA_KEY_JSON = process.env.GOOGLE_SA_KEY_JSON;
const GOOGLE_SA_CLIENT_EMAIL = process.env.GOOGLE_SA_CLIENT_EMAIL;
const GOOGLE_SA_PRIVATE_KEY = process.env.GOOGLE_SA_PRIVATE_KEY;

// ===== Helpers =====
function normalizeKey(key) {
  if (!key) return "";
  return key.includes("\\n") ? key.replace(/\\n/g, "\n") : key;
}

async function authSA() {
  let creds;
  if (GOOGLE_SA_KEY_JSON) {
    creds = JSON.parse(GOOGLE_SA_KEY_JSON);
  } else if (GOOGLE_SA_CLIENT_EMAIL && GOOGLE_SA_PRIVATE_KEY) {
    creds = {
      type: "service_account",
      client_email: GOOGLE_SA_CLIENT_EMAIL,
      private_key: normalizeKey(GOOGLE_SA_PRIVATE_KEY),
    };
  } else {
    throw new Error("Credenciais da Service Account ausentes.");
  }

  const jwt = new google.auth.JWT(
    creds.client_email,
    null,
    creds.private_key,
    ["https://www.googleapis.com/auth/drive"]
  );
  await jwt.authorize();
  return jwt;
}

function driveSA(auth) {
  return google.drive({ version: "v3", auth });
}

// ===== Localiza subpasta Memorias =====
async function getMemoriasFolderId(auth) {
  const drive = driveSA(auth);
  const q = [
    `'${DRIVE_FOLDER_BASE}' in parents`,
    "mimeType='application/vnd.google-apps.folder'",
    "name='Memorias'",
    "trashed=false"
  ].join(" and ");
  const { data } = await drive.files.list({ q, fields: "files(id,name)" });
  if (data.files?.length) return data.files[0].id;
  throw new Error("Pasta 'Memorias' não encontrada.");
}

// ===== Listar memórias =====
async function listMemory() {
  const auth = await authSA();
  const drive = driveSA(auth);
  const folderId = await getMemoriasFolderId(auth);

  const q = [
    `'${folderId}' in parents`,
    "mimeType='application/json'",
    "trashed=false"
  ].join(" and ");

  const { data } = await drive.files.list({
    q,
    fields: "files(id,name,modifiedTime,webViewLink)",
    orderBy: "modifiedTime desc",
  });

  const files = data.files || [];
  if (!files.length) {
    console.log(chalk.yellow("⚠️  Nenhuma memória encontrada na pasta Memorias."));
    return [];
  }

  console.table(
    files.map(f => ({
      id: f.id,
      name: f.name,
      updated: f.modifiedTime,
      link: f.webViewLink
    }))
  );
  return files;
}

// ===== Carregar conteúdo de uma memória =====
async function loadMemory(fileId) {
  if (!fileId) throw new Error("Informe o ID do arquivo (--id=<id>)");
  const auth = await authSA();
  const drive = driveSA(auth);
  const res = await drive.files.get({ fileId, alt: "media" }, { responseType: "json" });
  console.log(chalk.green(`🧩 Memória ${fileId} carregada:`));
  console.log(JSON.stringify(res.data, null, 2));
  return res.data;
}

// ===== CLI =====
async function main() {
  const args = Object.fromEntries(
    process.argv.slice(2).map(a => {
      const [k, ...r] = a.replace(/^--/, "").split("=");
      return [k, r.join("=")];
    })
  );

  try {
    const cmd = (args.cmd || "").toUpperCase();
    switch (cmd) {
      case "LIST_MEMORY":
        await listMemory();
        break;
      case "LOAD_MEMORY":
        await loadMemory(args.id);
        break;
      default:
        console.log("Use: node apps/amana/restoreContext.js --cmd=LIST_MEMORY | --cmd=LOAD_MEMORY --id=<id>");
    }
  } catch (e) {
    console.error(chalk.red("❌ Erro:"), e?.message);
  } finally {
    process.exit(0);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
