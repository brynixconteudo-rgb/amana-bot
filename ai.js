// ai.js
// 💡 Núcleo semântico do Amana_BOT — identifica intenções e entidades no texto do usuário

import OpenAI from "openai";
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ============================================================
// 🧠 processNaturalMessage
// ============================================================
export async function processNaturalMessage(text) {
  try {
    const prompt = `
    Analise a frase do usuário e extraia:
    - intent: uma das opções [CREATE_EVENT, READ_EMAILS, SEND_EMAIL, SAVE_MEMORY, UNKNOWN]
    - entities: campos relevantes (ex: summary, date, time, to, subject, body, title, content)
    Responda em JSON.

    Exemplo de saída:
    {
      "intent": "CREATE_EVENT",
      "entities": {
        "summary": "Reunião geral",
        "date": "amanhã",
        "time": "18h às 19h"
      }
    }

    Frase do usuário: "${text}"
    `;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
    });

    const response = completion.choices[0].message.content;
    const jsonStart = response.indexOf("{");
    const jsonEnd = response.lastIndexOf("}") + 1;
    const jsonText = response.slice(jsonStart, jsonEnd);
    const result = JSON.parse(jsonText);

    // fallback seguro
    return {
      intent: result.intent || "UNKNOWN",
      entities: result.entities || {},
    };
  } catch (err) {
    console.error("❌ Erro em processNaturalMessage:", err.message);
    return { intent: "UNKNOWN", entities: {} };
  }
}
