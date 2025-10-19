// ai.js
// 🧠 Núcleo de interpretação semântica do Amana_BOT
// Analisa mensagens livres e devolve { intent, entities } prontos
// Usa GPT-4-mini para extrair intenção e dados estruturados
// Compatível com todos os fluxos (evento, e-mail, memória, leitura de e-mails)

import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/**
 * Analisa uma mensagem do usuário e identifica intenção e entidades
 * @param {string} userText - Texto original enviado pelo usuário
 * @returns {Promise<{ intent: string, entities: object, confidence: number }>}
 */
export async function analyzeMessage(userText) {
  try {
    const prompt = `
Você é um assistente inteligente que interpreta comandos humanos para automação pessoal.
Analise a seguinte frase e retorne um JSON com três campos: "intent", "entities" e "confidence".

INTENTS possíveis:
- CREATE_EVENT → criar reunião, compromisso ou evento
- READ_EMAILS → ler e-mails, mensagens, verificar caixa de entrada
- SEND_EMAIL → enviar e-mail
- SAVE_MEMORY → salvar anotações, memórias, pensamentos
- UNKNOWN → se não for possível classificar

ENTITIES possíveis:
- summary: título ou assunto do evento
- date: data mencionada (ex: "amanhã", "20/10")
- start: horário de início (ex: "10:00")
- end: horário de fim (ex: "11:00")
- attendees: lista de e-mails ou nomes de participantes
- query: filtro para e-mails (ex: "importantes", "não lidos")
- to: destinatário(s) de e-mail
- subject: assunto do e-mail
- body: corpo da mensagem
- title: título da memória
- content: conteúdo da memória

Retorne **apenas** JSON válido, sem texto adicional.

Frase: "${userText}"
    `;

    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
    });

    const text = response.choices[0].message?.content || "{}";
    const parsed = JSON.parse(text);

    // Segurança: fallback para caso de erro no modelo
    return {
      intent: parsed.intent || "UNKNOWN",
      entities: parsed.entities || {},
      confidence: parsed.confidence || 0.5,
    };
  } catch (err) {
    console.error("❌ Erro em analyzeMessage:", err.message);
    return { intent: "UNKNOWN", entities: {}, confidence: 0 };
  }
}
