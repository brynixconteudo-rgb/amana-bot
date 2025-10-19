// apps/amana/memory.js
// Persistência de contexto por chatId

import fs from "fs";
import fsp from "fs/promises";
import path from "path";

// Disco persistente do Render
const BASE_DIR = path.resolve(process.env.MEMORY_DIR || "/var/data/memory");

// util
async function ensureDir(dir) {
  if (!fs.existsSync(dir)) await fsp.mkdir(dir, { recursive: true });
}

function defaultContext(chatId) {
  return {
    chatId,
    context: { intent: null, fields: {}, stage: null, history: [] },
    lastUpdate: new Date().toISOString(),
  };
}

function filePathFor(chatId) {
  const safe = String(chatId).replace(/[^a-zA-Z0-9_\-]/g, "_");
  return path.join(BASE_DIR, `${safe}.json`);
}

// API
export async function loadContext(chatId) {
  await ensureDir(BASE_DIR);
  const fp = filePathFor(chatId);
  try {
    const raw = await fsp.readFile(fp, "utf-8");
    return JSON.parse(raw);
  } catch {
    const fresh = defaultContext(chatId);
    await saveContext(chatId, fresh);
    return fresh;
  }
}

export async function saveContext(chatId, data) {
  await ensureDir(BASE_DIR);
  const fp = filePathFor(chatId);
  const payload = { ...data, lastUpdate: new Date().toISOString() };
  await fsp.writeFile(fp, JSON.stringify(payload, null, 2), "utf-8");
  return payload;
}

export async function clearContext(chatId) {
  await ensureDir(BASE_DIR);
  const fp = filePathFor(chatId);
  try { await fsp.unlink(fp); } catch {}
  const fresh = defaultContext(chatId);
  await saveContext(chatId, fresh);
  return fresh;
}

export async function updateContext(chatId, partial = {}) {
  const current = await loadContext(chatId);
  const next = {
    ...current,
    context: {
      ...current.context,
      ...partial,
      fields: { ...(current.context?.fields || {}), ...(partial.fields || {}) },
      history: limitHistory(
        Array.isArray(partial.history) ? partial.history : current.context?.history || []
      ),
    },
  };
  return await saveContext(chatId, next);
}

export async function pushHistory(chatId, entry) {
  const current = await loadContext(chatId);
  const hist = Array.isArray(current.context.history) ? current.context.history.slice() : [];
  hist.push({ role: entry.role, text: String(entry.text || "").slice(0, 500), at: new Date().toISOString() });
  current.context.history = limitHistory(hist);
  return await saveContext(chatId, current);
}

function limitHistory(hist) {
  const MAX = 12;
  if (!Array.isArray(hist)) return [];
  return hist.length <= MAX ? hist : hist.slice(hist.length - MAX);
}

export async function getDialogState(chatId) {
  const ctx = await loadContext(chatId);
  const { intent, fields, stage } = ctx.context || {};
  return { intent, fields: fields || {}, stage };
}

export async function beginTask(chatId, intent, initialFields = {}) {
  return await updateContext(chatId, { intent, fields: initialFields, stage: null });
}

export async function endTask(chatId) {
  return await updateContext(chatId, { intent: null, fields: {}, stage: null });
}
