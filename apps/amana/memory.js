// apps/amana/memory.js
// Persistência de contexto por chatId para o Amana_BOT
// - Guarda estado de intenção (intent), campos coletados (fields), estágio do diálogo (stage) e histórico curto
// - Salva em disco: /data/memory/<chatId>.json
// - API: loadContext, saveContext, updateContext, clearContext, pushHistory

import fs from "fs";
import fsp from "fs/promises";
import path from "path";

// 🧠 Corrigido: base persistente compatível com Render
// Render monta disco persistente em /var/data
const BASE_DIR =
  process.env.MEMORY_DIR ||
  path.resolve(process.env.PERSISTENT_DIR || "/var/data/memory");

const BASE_DIR = process.env.MEMORY_DIR || "/data/memory";

// ---------- util ----------
async function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    await fsp.mkdir(dir, { recursive: true });
  }
}

function defaultContext(chatId) {
  return {
    chatId,
    context: {
      intent: null,          // ex.: "CREATE_EVENT", "READ_EMAILS", "SAVE_MEMORY", etc.
      fields: {},            // campos coletados para a intenção atual
      stage: null,           // ex.: "awaiting_start", "awaiting_summary", ...
      history: []            // últimas interações (curtas) para referência local
    },
    lastUpdate: new Date().toISOString()
  };
}

function filePathFor(chatId) {
  // normaliza chatId para nome de arquivo
  const safe = String(chatId).replace(/[^a-zA-Z0-9_\-]/g, "_");
  return path.join(BASE_DIR, `${safe}.json`);
}

// ---------- API ----------
/** Carrega o contexto do chat. Cria padrão se não existir. */
export async function loadContext(chatId) {
  await ensureDir(BASE_DIR);
  const fp = filePathFor(chatId);
  try {
    const raw = await fsp.readFile(fp, "utf-8");
    const data = JSON.parse(raw);
    return data;
  } catch {
    const fresh = defaultContext(chatId);
    await saveContext(chatId, fresh);
    return fresh;
  }
}

/** Salva (overwrite) o contexto do chat. */
export async function saveContext(chatId, data) {
  await ensureDir(BASE_DIR);
  const fp = filePathFor(chatId);
  const payload = {
    ...data,
    lastUpdate: new Date().toISOString()
  };
  await fsp.writeFile(fp, JSON.stringify(payload, null, 2), "utf-8");
  return payload;
}

/** Apaga arquivo de contexto (reset). */
export async function clearContext(chatId) {
  await ensureDir(BASE_DIR);
  const fp = filePathFor(chatId);
  try {
    await fsp.unlink(fp);
  } catch {
    // ok se não existir
  }
  const fresh = defaultContext(chatId);
  await saveContext(chatId, fresh);
  return fresh;
}

/** Faz merge dos campos dentro de context, preservando o restante. */
export async function updateContext(chatId, partial = {}) {
  const current = await loadContext(chatId);
  const next = {
    ...current,
    context: {
      ...current.context,
      ...partial,
      // merge fino para "fields"
      fields: {
        ...(current.context?.fields || {}),
        ...(partial.fields || {})
      },
      // limita histórico local a 12 entradas
      history: limitHistory(
        Array.isArray(partial.history)
          ? partial.history
          : current.context?.history || []
      )
    }
  };
  return await saveContext(chatId, next);
}

/** Empilha uma linha no histórico local (user/bot) e limita tamanho. */
export async function pushHistory(chatId, entry /* {role: "user"|"bot", text: string} */) {
  const current = await loadContext(chatId);
  const hist = Array.isArray(current.context.history) ? current.context.history.slice() : [];
  hist.push({
    role: entry.role,
    text: String(entry.text || "").slice(0, 500),
    at: new Date().toISOString()
  });
  current.context.history = limitHistory(hist);
  return await saveContext(chatId, current);
}

// ---------- helpers ----------
function limitHistory(hist) {
  const MAX = 12;
  if (!Array.isArray(hist)) return [];
  if (hist.length <= MAX) return hist;
  return hist.slice(hist.length - MAX);
}

/** Retorna { intent, fields, stage } pronto para uso rápido */
export async function getDialogState(chatId) {
  const ctx = await loadContext(chatId);
  const { intent, fields, stage } = ctx.context || {};
  return { intent, fields: fields || {}, stage };
}

/** Atalho para fixar uma nova tarefa (resetando fields/stage). */
export async function beginTask(chatId, intent, initialFields = {}) {
  return await updateContext(chatId, {
    intent,
    fields: initialFields,
    stage: null
  });
}

/** Finaliza tarefa atual mantendo histórico. */
export async function endTask(chatId) {
  return await updateContext(chatId, {
    intent: null,
    fields: {},
    stage: null
  });
}
