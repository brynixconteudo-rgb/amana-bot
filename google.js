import { google } from "googleapis";

export async function authenticateGoogle() {
  const {
    GOOGLE_OAUTH_CLIENT_ID,
    GOOGLE_OAUTH_CLIENT_SECRET,
    GOOGLE_OAUTH_REFRESH_TOKEN
  } = process.env;

  const oauth2Client = new google.auth.OAuth2(
    GOOGLE_OAUTH_CLIENT_ID,
    GOOGLE_OAUTH_CLIENT_SECRET,
    "https://developers.google.com/oauthplayground"
  );

  oauth2Client.setCredentials({ refresh_token: GOOGLE_OAUTH_REFRESH_TOKEN });
  return oauth2Client;
}

// 🧠 Testa autenticação básica e acesso às APIs
export async function googleTest(auth) {
  const drive = google.drive({ version: "v3", auth });
  const sheets = google.sheets({ version: "v4", auth });
  const gmail = google.gmail({ version: "v1", auth });
  const calendar = google.calendar({ version: "v3", auth });

  // Coleta informações básicas
  const driveInfo = await drive.about.get({ fields: "user, storageQuota" });
  const calendarList = await calendar.calendarList.list({ maxResults: 3 });
  const labelList = await gmail.users.labels.list({ userId: "me" });

  return {
    drive_user: driveInfo.data.user.displayName,
    total_storage: driveInfo.data.storageQuota.limit,
    calendars: calendarList.data.items?.map(c => c.summary),
    gmail_labels: labelList.data.labels?.slice(0, 5).map(l => l.name)
  };
}
