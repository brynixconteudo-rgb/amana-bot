// teste_pontual.js
import { google } from "googleapis";
import { Readable } from "stream";

async function main() {
  try {
    const {
      GOOGLE_OAUTH_CLIENT_ID,
      GOOGLE_OAUTH_CLIENT_SECRET,
      GOOGLE_OAUTH_REFRESH_TOKEN,
      DRIVE_FOLDER_BASE,
    } = process.env;

    if (!GOOGLE_OAUTH_CLIENT_ID || !GOOGLE_OAUTH_CLIENT_SECRET || !GOOGLE_OAUTH_REFRESH_TOKEN) {
      throw new Error("⚠️ Variáveis OAuth ausentes. Configure ID, SECRET e REFRESH_TOKEN.");
    }

    const oauth2Client = new google.auth.OAuth2(
      GOOGLE_OAUTH_CLIENT_ID,
      GOOGLE_OAUTH_CLIENT_SECRET,
      "https://developers.google.com/oauthplayground"
    );
    oauth2Client.setCredentials({ refresh_token: GOOGLE_OAUTH_REFRESH_TOKEN });

    const drive = google.drive({ version: "v3", auth: oauth2Client });

    console.log("🚀 Autenticado com sucesso. Criando arquivo de teste...");

    const fileMetadata = {
      name: `TESTE_PONTUAL_${new Date().toISOString()}.txt`,
      parents: DRIVE_FOLDER_BASE ? [DRIVE_FOLDER_BASE] : undefined,
    };
    const media = {
      mimeType: "text/plain",
      body: Readable.from("Arquivo criado diretamente via teste_pontual.js ✅"),
    };

    const response = await drive.files.create({
      requestBody: fileMetadata,
      media,
      fields: "id, name, webViewLink, parents",
    });

    console.log("✅ Arquivo criado com sucesso!");
    console.log(response.data);
  } catch (err) {
    console.error("❌ Erro ao criar arquivo:", err.message);
  }
}

main();
