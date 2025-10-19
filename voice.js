// voice.js
// Camada de áudio do Amana_BOT
// - Converte mensagens de voz recebidas (OGG) em texto (Whisper)
// - Gera áudio de resposta a partir do texto do Amana_BOT (TTS)
// - Mantém separação clara entre “interpretação” (ai.js) e “voz”

import OpenAI from "openai";
import fs from "fs";
import axios from "axios";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

/** Transcreve áudio de voz (Telegram/WhatsApp) */
export async function transcreverAudio(url) {
  try {
    const response = await axios.get(url, { responseType: "arraybuffer" });
    fs.writeFileSync("temp.ogg", response.data);

    const transcription = await client.audio.transcriptions.create({
      file: fs.createReadStream("temp.ogg"),
      model: "whisper-1",
      language: "pt"
    });

    fs.unlinkSync("temp.ogg");
    return transcription.text;
  } catch (err) {
    console.error("❌ Erro na transcrição de áudio:", err.message);
    return null;
  }
}

/** Gera arquivo de áudio a partir de texto (voz natural Amana) */
export async function gerarAudio(texto) {
  try {
    const outputFile = "./resposta.mp3";

    const speech = await client.audio.speech.create({
      model: "gpt-4o-mini-tts",
      voice: "alloy",
      input: texto
    });

    const buffer = Buffer.from(await speech.arrayBuffer());
    fs.writeFileSync(outputFile, buffer);

    return outputFile;
  } catch (err) {
    console.error("❌ Erro ao gerar áudio:", err.message);
    return null;
  }
}
