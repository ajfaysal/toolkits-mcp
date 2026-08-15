// LofiMellowBot Telegram Webhook Handler — v3
// v2 fixes: (1) pairs audio+video sent separately by the same user into one
// combined job instead of processing video alone immediately, using R2 as
// simple per-chat state storage; (2) uses the correct download link format.
// v3 adds: Facebook video downloader + MP3/WAV audio extraction, delivered
// directly inside the chat as files (no external links). Flow: user pastes
// an FB link -> bot downloads and sends the video -> bot asks (inline button)
// if an audio version is wanted -> on tap, MP3 + WAV are extracted and sent.
//
// Bindings/secrets: TOOLKITS_BUCKET (R2), TELEGRAM_BOT_TOKEN, GITHUB_PAT,
// GITHUB_OWNER, GITHUB_REPO, R2_PUBLIC_BASE_URL

export interface Env {
  TOOLKITS_BUCKET: R2Bucket;
  TELEGRAM_BOT_TOKEN: string;
  GITHUB_PAT: string;
  GITHUB_OWNER: string;
  GITHUB_REPO: string;
  R2_PUBLIC_BASE_URL: string;
}

type PendingState = {
  type: "video" | "audio";
  input_key?: string;
  drive_id?: string;
  target_minutes: number;
  timestamp: number;
};

const PENDING_TTL_MS = 15 * 60 * 1000; // 15 minutes to send the pair

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

    // --- Inline button presses (e.g. "Make audio" button under an FB video) ---
    if (update.callback_query) {
      await handleCallbackQuery(env, update.callback_query);
      return new Response("ok");
    }

    const message = update.message;
    if (!message) return new Response("ok");
    const chatId = message.chat.id;
    const stateKey = `telegram-state/${chatId}.json`;

    if (message.text?.trim() === "/start") {
      await sendMessage(env, chatId,
        "Send me a short video (mp4) and a short/long audio (mp3 file or Google Drive link) — in either order. " +
        "I'll wait for both and combine them into one seamless long loop. " +
        "Or send just one of them and type /skip to process it alone (video gets no audio, audio loops on its own). " +
        "Caption a file with a number (minutes) to set duration, default 120. " +
        "\n\nYou can also paste a Facebook video link and I'll send the video back directly, with an option to convert it to MP3/WAV audio.");
      return new Response("ok");
    }

    if (message.text?.trim() === "/skip") {
      const pending = await readPending(env, stateKey);
      if (!pending) {
        await sendMessage(env, chatId, "Nothing pending to process.");
        return new Response("ok");
      }
      await env.TOOLKITS_BUCKET.delete(stateKey);
      await dispatchJob(env, chatId, {
        is_video: pending.type === "video",
        input_key: pending.input_key,
        drive_id: pending.drive_id,
        target_minutes: pending.target_minutes,
      });
      await sendMessage(env, chatId, "Got it, processing alone. Usually 2-5 minutes.");
      return new Response("ok");
    }

    // --- Facebook video link handling ---
    if (message.text && (message.text.includes("facebook.com") || message.text.includes("fb.watch"))) {
      const urlMatch = message.text.match(/https?:\/\/\S+/);
      if (urlMatch) {
        const jobId = crypto.randomUUID();
        await dispatchFbJob(env, chatId, "fb_download", { url: urlMatch[0], job_id: jobId });
        await sendMessage(env, chatId, "ফেসবুক ভিডিও ডাউনলোড হচ্ছে, একটু অপেক্ষা করো...");
        return new Response("ok");
      }
    }

    if (message.text && message.text.includes("drive.google.com")) {
      const driveMatch = message.text.match(/[-\w]{25,}/);
      if (driveMatch) {
        const driveId = driveMatch[0];
        const numberMatch = message.text.match(/\b(\d{1,4})\b/);
        const targetMinutes = numberMatch ? parseInt(numberMatch[1]) : 120;
        await handleIncoming(env, chatId, stateKey, { type: "audio", drive_id: driveId, target_minutes: targetMinutes });
        return new Response("ok");
      }
    }

    const file = message.audio || message.video || message.document;
    if (!file) {
      await sendMessage(env, chatId, "Please send an audio/video file, a Google Drive link for audio, or a Facebook video link.");
      return new Response("ok");
    }

    const isVideo = !!message.video || (message.document?.mime_type?.startsWith("video/"));
    const targetMinutes = message.caption && !isNaN(parseInt(message.caption)) ? parseInt(message.caption) : 120;

    try {
      const fileInfoRes = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getFile?file_id=${file.file_id}`);
      const fileInfo: any = await fileInfoRes.json();
      if (!fileInfo.ok) {
        await sendMessage(env, chatId,
          "Something went wrong: getFile failed. This usually means the file is too large — Telegram bots can only receive files up to 20MB directly. For large audio, please paste a Google Drive share link instead.");
        return new Response("ok");
      }

      const telegramFileUrl = `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${fileInfo.result.file_path}`;
      const fileBytes = await (await fetch(telegramFileUrl)).arrayBuffer();

      const ext = isVideo ? "mp4" : "mp3";
      const inputKey = `telegram-inputs/${chatId}-${Date.now()}.${ext}`;
      await env.TOOLKITS_BUCKET.put(inputKey, fileBytes);

      await handleIncoming(env, chatId, stateKey, {
        type: isVideo ? "video" : "audio",
        input_key: inputKey,
        target_minutes: targetMinutes,
      });
    } catch (err: any) {
      await sendMessage(env, chatId, "Something went wrong: " + err.message);
    }

    return new Response("ok");
  },
};

async function handleIncoming(
  env: Env,
  chatId: number,
  stateKey: string,
  incoming: { type: "video" | "audio"; input_key?: string; drive_id?: string; target_minutes: number }
) {
  const pending = await readPending(env, stateKey);

  if (pending && pending.type !== incoming.type && Date.now() - pending.timestamp < PENDING_TTL_MS) {
    await env.TOOLKITS_BUCKET.delete(stateKey);
    const video = incoming.type === "video" ? incoming : pending;
    const audio = incoming.type === "audio" ? incoming : pending;
    await dispatchJob(env, chatId, {
      is_video: true,
      input_key: video.input_key,
      audio_input_key: audio.input_key,
      audio_drive_id: audio.drive_id,
      target_minutes: incoming.target_minutes || pending.target_minutes,
    });
    await sendMessage(env, chatId, "Got both! Combining video + audio into one seamless loop. Usually 2-5 minutes.");
    return;
  }

  const state: PendingState = {
    type: incoming.type,
    input_key: incoming.input_key,
    drive_id: incoming.drive_id,
    target_minutes: incoming.target_minutes,
    timestamp: Date.now(),
  };
  await env.TOOLKITS_BUCKET.put(stateKey, JSON.stringify(state));

  const otherType = incoming.type === "video" ? "audio" : "video";
  await sendMessage(env, chatId,
    `Got the ${incoming.type}! Now send me the ${otherType} to pair with it, or type /skip to process this one alone.`);
}

async function readPending(env: Env, stateKey: string): Promise<PendingState | null> {
  const obj = await env.TOOLKITS_BUCKET.get(stateKey);
  if (!obj) return null;
  try {
    const state: PendingState = JSON.parse(await obj.text());
    if (Date.now() - state.timestamp > PENDING_TTL_MS) {
      await env.TOOLKITS_BUCKET.delete(stateKey);
      return null;
    }
    return state;
  } catch {
    return null;
  }
}

async function dispatchJob(env: Env, chatId: number, payload: Record<string, any>) {
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
      client_payload: { chat_id: chatId, ...payload },
    }),
  });
  if (!ghRes.ok) {
    await sendMessage(env, chatId, "Something went wrong dispatching the job: " + await ghRes.text());
  }
}

// --- Facebook downloader helpers ---

async function handleCallbackQuery(env: Env, callbackQuery: any) {
  const data: string = callbackQuery.data || "";
  const chatId = callbackQuery.message?.chat?.id;

  // Acknowledge the button press so Telegram stops the loading spinner
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQuery.id }),
  });

  if (data.startsWith("fb_audio:") && chatId) {
    const jobId = data.replace("fb_audio:", "");
    await dispatchFbJob(env, chatId, "fb_audio", { job_id: jobId });
    await sendMessage(env, chatId, "অডিও (MP3/WAV) বানানো হচ্ছে...");
  }
}

async function dispatchFbJob(env: Env, chatId: number, eventType: "fb_download" | "fb_audio", payload: Record<string, any>) {
  const ghRes = await fetch(`https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/dispatches`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.GITHUB_PAT}`,
      "Accept": "application/vnd.github+json",
      "User-Agent": "LofiMellowBot-Worker",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      event_type: eventType,
      client_payload: { chat_id: chatId, ...payload },
    }),
  });
  if (!ghRes.ok) {
    await sendMessage(env, chatId, "Something went wrong: " + await ghRes.text());
  }
}

async function sendMessage(env: Env, chatId: number, text: string) {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}
