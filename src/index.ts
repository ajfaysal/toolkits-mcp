// LofiMellowBot Telegram Webhook Handler
// Required bindings/secrets: R2 bucket TOOLKITS_BUCKET, secrets TELEGRAM_BOT_TOKEN
// and GITHUB_PAT, vars GITHUB_OWNER, GITHUB_REPO, R2_PUBLIC_BASE_URL

export interface Env {
  TOOLKITS_BUCKET: R2Bucket;
  TELEGRAM_BOT_TOKEN: string;
  GITHUB_PAT: string;
  GITHUB_OWNER: string;
  GITHUB_REPO: string;
  R2_PUBLIC_BASE_URL: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("LofiMellowBot webhook is alive.", { status: 200 });
    }

    let update: any;
    try {
      update = await request.json();
    } catch {
      return new Response("bad request", { status: 400 });
    }

    const message = update.message;
    if (!message) return new Response("ok");
    const chatId = message.chat.id;

    if (message.text?.trim() === "/start") {
      await sendMessage(env, chatId,
        "Send me a short audio (mp3) or video (mp4) clip and I'll turn it into a seamless long loop. " +
        "You can also paste a Google Drive share link for audio. " +
        "Caption a file with a number (minutes) to set duration, default 120.");
      return new Response("ok");
    }

    // Handle Google Drive link sent as plain text (for audio)
    if (message.text && message.text.includes("drive.google.com")) {
      const driveMatch = message.text.match(/[-\w]{25,}/);
      if (driveMatch) {
        const driveId = driveMatch[0];
        const numberMatch = message.text.match(/\b(\d{1,4})\b/);
        const targetMinutes = numberMatch ? parseInt(numberMatch[1]) : 120;

        await sendMessage(env, chatId, "Got the Drive link! Processing, usually a few minutes.");

        try {
          const ghRes = await fetch(
            `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/dispatches`,
            {
              method: "POST",
              headers: {
                "Authorization": `Bearer ${env.GITHUB_PAT}`,
                "Accept": "application/vnd.github+json",
                "User-Agent": "LofiMellowBot-Worker",
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                event_type: "process_loop",
                client_payload: {
                  drive_id: driveId,
                  is_video: false,
                  chat_id: chatId,
                  target_minutes: targetMinutes,
                },
              }),
            }
          );
          if (!ghRes.ok) throw new Error("GitHub dispatch failed: " + await ghRes.text());
        } catch (err: any) {
          await sendMessage(env, chatId, "Something went wrong: " + err.message);
        }
        return new Response("ok");
      }
    }

    const file = message.audio || message.video || message.document;
    if (!file) {
      await sendMessage(env, chatId, "Please send an audio/video file, or a Google Drive link for audio.");
      return new Response("ok");
    }

    const isVideo = !!message.video || (message.document?.mime_type?.startsWith("video/"));
    const targetMinutes = message.caption && !isNaN(parseInt(message.caption)) ? parseInt(message.caption) : 120;

    await sendMessage(env, chatId, "Got it! Processing, usually 2-5 minutes.");

    try {
      const fileInfoRes = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getFile?file_id=${file.file_id}`);
      const fileInfo: any = await fileInfoRes.json();
      if (!fileInfo.ok) throw new Error("getFile failed");

      const telegramFileUrl = `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${fileInfo.result.file_path}`;
      const fileBytes = await (await fetch(telegramFileUrl)).arrayBuffer();

      const ext = isVideo ? "mp4" : "mp3";
      const inputKey = `telegram-inputs/${chatId}-${Date.now()}.${ext}`;
      await env.TOOLKITS_BUCKET.put(inputKey, fileBytes);

      const ghRes = await fetch(`https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/dispatches`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${env.GITHUB_PAT}`,
          "Accept": "application/vnd.github+json",
          "User-Agent": "LofiMellowBot-Worker",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          event_type: "process_loop",
          client_payload: { input_key: inputKey, is_video: isVideo, chat_id: chatId, target_minutes: targetMinutes },
        }),
      });
      if (!ghRes.ok) throw new Error("GitHub dispatch failed: " + await ghRes.text());
    } catch (err: any) {
      await sendMessage(env, chatId, "Something went wrong: " + err.message);
    }
    return new Response("ok");
  },
};

async function sendMessage(env: Env, chatId: number, text: string) {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}
