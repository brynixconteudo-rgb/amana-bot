// apps/amana/voice.js
import fs from "fs";
import axios from "axios";
import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function transcreverAudio(url) {
  try {
    console.log("🎧 Recebido áudio, iniciando transcrição...");
    const response = await axios.get(url, { responseType: "arraybuffer" });
    const filePath = "./temp.ogg";
    fs.writeFileSync(filePath, response.data);

    const transcription = await client.audio.transcriptions.create({
      file: fs.createReadStream(filePath),
      model: "whisper-1",
      language: "pt",
    });

    fs.unlinkSync(filePath);
    console.log("📝 Transcrição:", transcription.text);
    return transcription.text;
  } catch (err) {
    console.error("❌ Erro na transcrição de áudio:", err.message);
    return null;
  }
}

export async function gerarAudio(texto) {
  try {
    const outputFile = "./resposta.mp3";
    const speech = await client.audio.speech.create({
      model: "gpt-4o-mini-tts",
      voice: "alloy",
      input: texto,
    });
    const buffer = Buffer.from(await speech.arrayBuffer());
    fs.writeFileSync(outputFile, buffer);
    console.log("🎤 Áudio gerado:", outputFile);
    return outputFile;
  } catch (err) {
    console.error("❌ Erro ao gerar áudio:", err.message);
    return null;
  }
}
