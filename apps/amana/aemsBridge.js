// apps/amana/aemsBridge.js
// 🧠 AEMS Bridge — “ponte” entre o chat (Amana viva) e o Drive (Amana armazenada)
// - Orquestra carregar projeto por nome (via índice global) e restaurar contexto ativo
// - Expõe utilidades para listar projetos, listar memórias, carregar por id/índice/nome
// - Lê e resume o arquivo _runtime/context_active.json para retomar a conversa exatamente de onde parou
//
// CLI (exemplos):
//   node apps/amana/aemsBridge.js --cmd=LIST_PROJECTS
//   node apps/amana/aemsBridge.js --cmd=LOAD_PROJECT --project="AEMS_TEST"
//   node apps/amana/aemsBridge.js --cmd=LIST_MEMORY
//   node apps/amana/aemsBridge.js --cmd=LOAD_MEMORY --id=0
//   node apps/amana/aemsBridge.js --cmd=ACTIVE       # mostra caminho e chaves do contexto ativo
//   node apps/amana/aemsBridge.js --cmd=SUMMARY      # resumo rápido do contexto ativo
//   node apps/amana/aemsBridge.js --cmd=SHOW         # últimas linhas do JSON ativo (para conferência)

import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import chalk from "chalk";
import { fileURLToPath } from "url";

// Importa utilidades de restauração (já criadas)
import {
  listMemory as rcListMemory,
  loadMemory as rcLoadMemory,
  listProjects as rcListProjects,
  loadProject as rcLoadProject,
} from "./restoreContext.js";

// ---------- chdir para a raiz do projeto (este arquivo fica em src/apps/amana) ----------
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
// raiz provável: 2 níveis acima de /apps/amana
const PROJECT_ROOT = path.resolve(__dirname, "../../");
try { process.chdir(PROJECT_ROOT); } catch { /* ok */ }

// ---------- Constantes locais ----------
const RUNTIME_DIR = path.resolve("./_runtime");
const ACTIVE_PATH = path.join(RUNTIME_DIR, "context_active.json");

// ---------- Helpers básicos ----------
function ensureRuntimePath() {
  if (!fs.existsSync(RUNTIME_DIR)) fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  return RUNTIME_DIR;
}
function pretty(obj) { return JSON.stringify(obj, null, 2); }
function printLastLines(text, n = 12) {
  const lines = text.split(/\r?\n/);
  const slice = lines.slice(Math.max(0, lines.length - n));
  console.log(chalk.gray("\n— últimas linhas —"));
  console.log(slice.join("\n"));
  console.log(chalk.gray("— fim —\n"));
}

// ---------- Núcleo do Bridge ----------
export async function loadActiveContext() {
  ensureRuntimePath();
  if (!fs.existsSync(ACTIVE_PATH)) {
    console.log(chalk.yellow("Nenhum contexto ativo encontrado em _runtime/context_active.json."));
    return null;
  }
  try {
    const txt = await fsp.readFile(ACTIVE_PATH, "utf-8");
    return JSON.parse(txt);
  } catch (e) {
    console.error(chalk.red("❌ Erro ao ler contexto ativo:"), e.message);
    return null;
  }
}

export async function summarizeActiveContext() {
  const ctx = await loadActiveContext();
  if (!ctx) return null;

  // Estrutura-base esperada pelos nossos snapshots/memórias
  const meta = ctx.meta || {};
  const state = ctx.state || {};
  const conv  = ctx.conversation || {};
  const turns = Array.isArray(conv.turns) ? conv.turns : [];

  // últimos 3 turnos (se houver)
  const lastTurns = turns.slice(-3).map((t) => {
    // formato flexível; normaliza o que der
    if (typeof t === "string") return t;
    if (t && typeof t === "object") {
      // tenta achar quem falou e o texto
      const speaker = t.role || t.speaker || t.who || "turn";
      const text =
        t.text || t.content || t.message || t.say || (Array.isArray(t.parts) ? t.parts.join(" ") : JSON.stringify(t));
      return `${speaker}: ${String(text).slice(0, 300)}`;
    }
    return String(t);
  });

  const summary = {
    snapshot_at: ctx.snapshot_at || meta.snapshot_at || null,
    project: meta.project || meta.name || state.project || null,
    state_summary: state.summary || meta.summary || null,
    objectives_count: Array.isArray(state.objectives) ? state.objectives.length : 0,
    key_decisions_count: Array.isArray(state.key_decisions) ? state.key_decisions.length : 0,
    last_turns: lastTurns,
    // Se veio um “raw” (texto solto), mostra um preview
    raw_preview: ctx.raw ? String(ctx.raw).slice(0, 240) : null,
  };

  console.log(chalk.cyan("\n🧭 Resumo do contexto ativo:"));
  console.log(pretty(summary));
  return summary;
}

export async function listProjects() {
  // usa o índice global lido pelo restoreContext
  return await rcListProjects();
}

export async function loadProject(projectName) {
  if (!projectName) throw new Error("Informe um nome de projeto. Ex: --project=\"AEMS_TEST\"");
  // delega a lógica de índice + restauração ao restoreContext
  const meta = await rcLoadProject({ project: projectName });
  // em seguida, lê o contexto para devolver já pronto para consumo
  const ctx = await loadActiveContext();
  return { meta, active: ctx };
}

export async function listMemory() {
  // lista todas as memórias *_CONTEXT.json (inclusive subpastas) via restoreContext
  return await rcListMemory();
}

export async function loadMemory(idOrName) {
  if (!idOrName) throw new Error("Use --id=<driveId|#index|nome-parcial>");
  const meta = await rcLoadMemory({ id: idOrName });
  const ctx = await loadActiveContext();
  return { meta, active: ctx };
}

// ---------- Utilidades para o Chat (diagnóstico rápido) ----------
export async function showActive() {
  const ctx = await loadActiveContext();
  if (!ctx) return null;
  const keys = Object.keys(ctx);
  console.log(chalk.green("✅ Contexto ativo carregado."));
  console.table([{ path: ACTIVE_PATH, keys: keys.join(", "), snapshot_at: ctx.snapshot_at || null }]);
  return { path: ACTIVE_PATH, keys, snapshot_at: ctx.snapshot_at || null };
}

export async function showTail() {
  const ctx = await loadActiveContext();
  if (!ctx) return null;
  const text = pretty(ctx);
  printLastLines(text, 14);
  return true;
}

// ---------- CLI ----------
async function main() {
  try {
    const args = Object.fromEntries(
      process.argv.slice(2).map(a => {
        const [k, ...r] = a.replace(/^--/, "").split("=");
        return [k, r.join("=")];
      })
    );
    const cmd = (args.cmd || "").toUpperCase();
    if (!cmd) {
      console.log(chalk.yellow("Use:"));
      console.log("  --cmd=LIST_PROJECTS");
      console.log("  --cmd=LOAD_PROJECT  --project=\"AEMS_TEST\"");
      console.log("  --cmd=LIST_MEMORY");
      console.log("  --cmd=LOAD_MEMORY   --id=<driveId|#index|nome-parcial>");
      console.log("  --cmd=ACTIVE");
      console.log("  --cmd=SUMMARY");
      console.log("  --cmd=SHOW");
      process.exit(0);
    }

    switch (cmd) {
      case "LIST_PROJECTS":
        await listProjects(); // já imprime tabela
        break;

      case "LOAD_PROJECT": {
        const project = args.project;
        const out = await loadProject(project);
        // Mostra um resumo após carregar
        await summarizeActiveContext();
        console.log(chalk.green("\n✅ Projeto carregado:"), project);
        break;
      }

      case "LIST_MEMORY":
        await listMemory(); // já imprime tabela
        break;

      case "LOAD_MEMORY": {
        const id = args.id;
        const out = await loadMemory(id);
        await summarizeActiveContext();
        console.log(chalk.green("\n✅ Memória carregada."), `(id/ref: ${id})`);
        break;
      }

      case "ACTIVE":
        await showActive();
        break;

      case "SUMMARY":
        await summarizeActiveContext();
        break;

      case "SHOW":
        await showTail();
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

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
