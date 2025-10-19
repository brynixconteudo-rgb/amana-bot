// ai.js — somente interpretação (sem executar ações)
// Evita conflito com fluxos guiados. Use como fallback de conversa.

import axios from "axios";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

const SYSTEM_PROMPT = `
Você é o Amana_BOT. Responda de forma breve, clara e amigável.
Se o usuário pedir ações (reunião, e-mail, etc.), **NÃO** execute nem proponha JSON aqui — apenas confirme entendimento em linguagem natural.
Fluxos e execução são responsabilidade de outro módulo.
`;

function safeParseJson(maybeJson) {
  if (typeof maybeJson !== "string") return null;
  const first = maybeJson.indexOf("{");
  const last = maybeJson.lastIndexOf("}");
  if (first === -1 || last === -1 || last < first) return null;
  try { return JSON.parse(maybeJson.slice(first, last + 1)); } catch { return null; }
}

async function callOpenAI(userText) {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY ausente.");
  const payload = {
    model: OPENAI_MODEL,
    temperature: 0.2,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userText }
    ]
  };
  const res = await axios.post(OPENAI_URL, payload, {
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    timeout: 30000
  });
  const content = res?.data?.choices?.[0]?.message?.content || "";
  return content?.trim() || "Ok.";
}

export async function processNaturalMessage({ text }) {
  if (!text || !text.trim()) return { reply: "Pode repetir? Não entendi.", executedAction: null };
  const reply = await callOpenAI(text);
  return { reply, executedAction: null };
}
