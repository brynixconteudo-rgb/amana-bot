// apps/amana/linkRestorer.js
// 🔁 Amana Link Restorer — Restaura snapshots a partir de links do Drive
// --------------------------------------------------------------
// Permite restaurar contextos completos (projetos, chats ou narrativas)
// salvos via linkReceiver.js, salvando-os localmente em _runtime/
// e atualizando o índice global Amana_INDEX.json.
//
// CLI EXEMPLOS:
// node apps/amana/linkRestorer.js --cmd=RESTORE_LINK --project="FATOS_DO_MUNDO" --id="1TZ5WuxyucjK3AQVoGNhy0Ef7rwPQavtW"
//
// ENV obrigatórios:
// DRIVE_FOLDER_BASE=...
// GOOGLE_OAUTH_CLIENT_ID=...
// GOOGLE_OAUTH_CLIENT_SECRET=...
// GOOGLE_OAUTH_REFRESH_TOKEN=...

import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import chalk from "chalk";
import { Readable } from "stream";
import { fileURLToPath } from "url";
import { google } from "googleapis";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "../../");
try { process.chdir(PROJECT_ROOT); } catch {}

const DRIVE_FOLDER_BASE = process.env.DRIVE_FOLDER_BASE;
const OAUTH = {
  id: process.env.GOOGLE_OAUTH_CLIENT_ID,
  secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
  refresh: process.env.GOOGLE_OAUTH_REFRESH_TOKEN,
  redirect: "https://developers.google.com/oauthplayground",
};

// ---------- AUTH ----------
async function authUserOAuth() {
  const { id, secret, refresh } = OAUTH;
  if (!id || !secret || !refresh) throw new Error("OAuth ausente (GOOGLE_OAUTH_CLIENT_ID/SECRET/REFRESH_TOKEN).");
  const oauth2 = new google.auth.OAuth2(id, secret, OAUTH.redirect);
  oauth2.setCredentials({ refresh_token: refresh });
  return oauth2;
}
function driveOAuth(auth) {
  return google.drive({ version: "v3", auth });
}

// ---------- HELPERS ----------
function ensureRuntimePath() {
  const p = path.resolve("./_runtime");
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  return p;
}
function pretty(obj) {
  return JSON.stringify(obj, null, 2);
}
function printLastLines(text, n = 12) {
  const lines = text.split(/\r?\n/);
  const slice = lines.slice(Math.max(0, lines.length - n));
  console.log(chalk.gray("\n— últimas linhas —"));
  console.log(slice.join("\n"));
  console.log(chalk.gray("— fim —\n"));
}

// ---------- DRIVE OPS ----------
async function getFileContentFromDrive(fileId) {
  const auth = await authUserOAuth();
  const drive = driveOAuth(auth);
  const res = await drive.files.get({ fileId, alt: "media" }, { responseType: "arraybuffer" });
  return Buffer.from(res.data).toString("utf-8");
}

async function updateGlobalIndex(project, title, link) {
  const auth = await authUserOAuth();
  const drive = driveOAuth(auth);

  const q = [
    `'${DRIVE_FOLDER_BASE}' in parents`,
    "trashed=false",
    "name='Amana_INDEX.json'"
  ].join(" and ");

  const { data } = await drive.files.list({ q, fields: "files(id,name)" });
  const file = data.files?.[0];
  let index = [];

  if (file) {
    try {
      const res = await drive.files.get({ fileId: file.id, alt: "media" }, { responseType: "text" });
      index = JSON.parse(res.data);
      if (!Array.isArray(index)) index = [];
    } catch {}
  }

  index.push({
    project,
    title,
    link,
    timestamp: new Date().toISOString(),
  });

  const media = { mimeType: "application/json", body: Readable.from([JSON.stringify(index, null, 2)]) };

  if (file) {
    await drive.files.update({ fileId: file.id, media });
  } else {
    await drive.files.create({
      requestBody: { name: "Amana_INDEX.json", parents: [DRIVE_FOLDER_BASE], mimeType: "application/json" },
      media,
    });
  }
  console.log(chalk.green("📚 Índice global atualizado com entrada de"), project);
}

// ---------- RESTORE LINK ----------
async function restoreLink({ project, id }) {
  if (!id) throw new Error("Informe --id=<fileId do snapshot>");
  console.log(chalk.cyan("🌐 Baixando snapshot do Drive..."));

  const content = await getFileContentFromDrive(id);
  let json;
  try {
    json = JSON.parse(content);
  } catch {
    throw new Error("O conteúdo baixado não é um JSON válido.");
  }

  const runtimeDir = ensureRuntimePath();
  const outPath = path.join(runtimeDir, "context_active.json");
  await fsp.writeFile(outPath, pretty(json), "utf-8");

  const link = `https://drive.google.com/file/d/${id}/view?usp=drivesdk`;
  await updateGlobalIndex(project, json.meta?.title || "Snapshot restaurado", link);

  console.log(chalk.green("✅ Contexto restaurado em:"), outPath);
  printLastLines(pretty(json), 12);

  const summary = {
    project,
    snapshot: link,
    keys: Object.keys(json),
    lines: content.split(/\r?\n/).length,
  };

  console.log(chalk.cyan("🧭 Resumo do contexto ativo:"));
  console.log(pretty(summary));

  return summary;
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
    if (cmd !== "RESTORE_LINK") throw new Error("Use: --cmd=RESTORE_LINK");

    await restoreLink({ project: args.project, id: args.id });
  } catch (e) {
    console.error(chalk.red("❌ Erro:"), e.message);
  } finally {
    process.exit(0);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
