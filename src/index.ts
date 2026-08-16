// LofiMellowBot Telegram Webhook Handler — v9
// v2 fixes: pairs audio+video sent separately into one combined job.
// v3 added: Facebook video downloader + MP3/WAV audio extraction.
// v5 added: YouTube video downloader + MP3/WAV audio extraction.
// v6 fixed: multiple links in one message all get downloaded.
// v7 added: batch "convert all to audio" button for multi-link messages.
// v8 added: /meta — metadata editor for user-uploaded files.
// v9 adds: after FB/YT audio conversion finishes, bot asks "edit metadata or
// skip?" with buttons. Edit reuses the same title/filename flow as /meta,
// applied to the just-downloaded audio (pulled from a short-lived R2 cache).
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

type BatchState = {
  chat_id: number;
  platform: "fb" | "yt";
  job_ids: string[];
};

type MetaState = {
  stage: "awaiting_file" | "awaiting_title" | "awaiting_filename";
  source: "upload" | "cached";
  input_key?: string;
  ext?: string;
  is_video?: boolean;
  job_id?: string;
  title?: string;
  timestamp: number;
};

const PENDING_TTL_MS = 15 * 60 * 1000; // 15 minutes to send the pair
const META_TTL_MS = 20 * 60 * 1000; // 20 minutes to complete the /meta flow

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

    if (update.callback_query) {
      await handleCallbackQuery(env, update.callback_query);
      return new Response("ok");
    }

    const message = update.message;
    if (!message) return new Response("ok");
    const chatId = message.chat.id;
    const stateKey = `telegram-state/${chatId}.json`;
    const metaKey = `telegram-meta/${chatId}.json`;

    if (message.text?.trim() === "/start") {
      await sendMessage(env, chatId,
        "Send me a short video (mp4) and a short/long audio (mp3 file or Google Drive link) — in either order. " +
        "I'll wait for both and combine them into one seamless long loop. " +
        "Or send just one of them and type /skip to process it alone (video gets no audio, audio loops on its own). " +
        "Caption a file with a number (minutes) to set duration, default 120. " +
        "\n\nYou can also paste one or more Facebook or YouTube video links and I'll send each video back directly, with an option to convert one or all of them to MP3/WAV audio — and after the audio is ready, you'll get the option to edit its title/filename too." +
        "\n\nType /meta to edit a file's title and filename yourself (strips old metadata, sets a new one).");
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

    // --- /meta flow start (user uploads their own file) ---
    if (message.text?.trim() === "/meta") {
      const state: MetaState = { stage: "awaiting_file", source: "upload", timestamp: Date.now() };
      await env.TOOLKITS_BUCKET.put(metaKey, JSON.stringify(state));
      await sendMessage(env, chatId, "ফাইল পাঠাও (audio অথবা video) — এর title আর filename বদলে দেব।");
      return new Response("ok");
    }

    if (message.text?.trim() === "/cancel") {
      await env.TOOLKITS_BUCKET.delete(metaKey);
      await sendMessage(env, chatId, "ঠিক আছে, বাতিল করা হলো।");
      return new Response("ok");
    }

    // --- /meta flow: title / filename text steps (works for both "upload" and "cached" sources) ---
    const metaState = await readMeta(env, metaKey);
    if (metaState && message.text) {
      if (metaState.stage === "awaiting_title") {
        metaState.title = message.text.trim();
        metaState.stage = "awaiting_filename";
        metaState.timestamp = Date.now();
        await env.TOOLKITS_BUCKET.put(metaKey, JSON.stringify(metaState));
        await sendMessage(env, chatId, "ঠিক আছে। এখন নতুন ফাইলের নাম দাও (extension ছাড়া, শুধু নাম)।");
        return new Response("ok");
      }
      if (metaState.stage === "awaiting_filename") {
        const filename = message.text.trim().replace(/[\\/:*?"<>|]/g, "");
        await env.TOOLKITS_BUCKET.delete(metaKey);

        if (metaState.source === "cached") {
          await dispatchDownloadJob(env, chatId, "meta_edit_cached", {
            job_id: metaState.job_id,
            title: metaState.title,
            filename,
          });
        } else {
          await dispatchDownloadJob(env, chatId, "meta_edit", {
            input_key: metaState.input_key,
            ext: metaState.ext,
            is_video: metaState.is_video,
            title: metaState.title,
            filename,
          });
        }
        await sendMessage(env, chatId, "মেটাডেটা পরিবর্তন হচ্ছে, একটু অপেক্ষা করো...");
        return new Response("ok");
      }
    }

    // --- Facebook video link handling (supports multiple links in one message) ---
    if (message.text && (message.text.includes("facebook.com") || message.text.includes("fb.watch"))) {
      const urls = Array.from(message.text.matchAll(/https?:\/\/\S+/g)).map((m: any) => m[0]);
      if (urls.length > 0) {
        await handleMultiDownload(env, chatId, "fb", urls);
        return new Response("ok");
      }
    }

    // --- YouTube video link handling (supports multiple links in one message) ---
    if (message.text && (message.text.includes("youtube.com") || message.text.includes("youtu.be"))) {
      const urls = Array.from(message.text.matchAll(/https?:\/\/\S+/g)).map((m: any) => m[0]);
      if (urls.length > 0) {
        await handleMultiDownload(env, chatId, "yt", urls);
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
      await sendMessage(env, chatId, "Please send an audio/video file, a Google Drive link for audio, or a Facebook/YouTube video link. Or type /meta to edit a file's metadata.");
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

      if (metaState && metaState.stage === "awaiting_file") {
        metaState.input_key = inputKey;
        metaState.ext = ext;
        metaState.is_video = isVideo;
        metaState.stage = "awaiting_title";
        metaState.timestamp = Date.now();
        await env.TOOLKITS_BUCKET.put(metaKey, JSON.stringify(metaState));
        await sendMessage(env, chatId, "ফাইল পেয়েছি। এখন নতুন Title (শিরোনাম) কী দিতে চাও, লিখে পাঠাও।");
        return new Response("ok");
      }

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

async function readMeta(env: Env, metaKey: string): Promise<MetaState | null> {
  const obj = await env.TOOLKITS_BUCKET.get(metaKey);
  if (!obj) return null;
  try {
    const state: MetaState = JSON.parse(await obj.text());
    if (Date.now() - state.timestamp > META_TTL_MS) {
      await env.TOOLKITS_BUCKET.delete(metaKey);
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

// --- Downloader helpers (shared by Facebook and YouTube) ---

async function handleMultiDownload(env: Env, chatId: number, platform: "fb" | "yt", urls: string[]) {
  const jobIds: string[] = [];
  const downloadEvent = platform === "fb" ? "fb_download" : "yt_download";
  const platformLabel = platform === "fb" ? "ফেসবুক" : "ইউটিউব";

  for (const url of urls) {
    const jobId = crypto.randomUUID();
    jobIds.push(jobId);
    await dispatchDownloadJob(env, chatId, downloadEvent, { url, job_id: jobId });
  }

  if (urls.length === 1) {
    await sendMessage(env, chatId, `${platformLabel} ভিডিও ডাউনলোড হচ্ছে, একটু অপেক্ষা করো...`);
    return;
  }

  const batchId = crypto.randomUUID();
  const batch: BatchState = { chat_id: chatId, platform, job_ids: jobIds };
  await env.TOOLKITS_BUCKET.put(`telegram-batch/${batchId}.json`, JSON.stringify(batch));

  await sendMessage(env, chatId, `${urls.length}টা ${platformLabel} ভিডিও ডাউনলোড হচ্ছে, একটু অপেক্ষা করো...`);

  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: `সবগুলো ভিডিও (${urls.length}টা) chat-এ চলে আসার পর নিচের বাটনে চাপলে একসাথে সবগুলোর Audio (MP3/WAV) বানানো হবে।`,
      reply_markup: {
        inline_keyboard: [[{ text: `🎵 সব ${urls.length}টার Audio বানাও`, callback_data: `batch_audio:${batchId}` }]],
      },
    }),
  });
}

async function handleCallbackQuery(env: Env, callbackQuery: any) {
  const data: string = callbackQuery.data || "";
  const chatId = callbackQuery.message?.chat?.id;

  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQuery.id }),
  });

  if (!chatId) return;

  if (data.startsWith("fb_audio:")) {
    const jobId = data.replace("fb_audio:", "");
    await dispatchDownloadJob(env, chatId, "fb_audio", { job_id: jobId });
    await sendMessage(env, chatId, "অডিও (MP3/WAV) বানানো হচ্ছে...");
  } else if (data.startsWith("yt_audio:")) {
    const jobId = data.replace("yt_audio:", "");
    await dispatchDownloadJob(env, chatId, "yt_audio", { job_id: jobId });
    await sendMessage(env, chatId, "অডিও (MP3/WAV) বানানো হচ্ছে...");
  } else if (data.startsWith("batch_audio:")) {
    const batchId = data.replace("batch_audio:", "");
    const obj = await env.TOOLKITS_BUCKET.get(`telegram-batch/${batchId}.json`);
    if (!obj) {
      await sendMessage(env, chatId, "এই ব্যাচটা আর খুঁজে পাওয়া যাচ্ছে না।");
      return;
    }
    const batch: BatchState = JSON.parse(await obj.text());
    const audioEvent = batch.platform === "fb" ? "fb_audio" : "yt_audio";
    for (const jobId of batch.job_ids) {
      await dispatchDownloadJob(env, chatId, audioEvent, { job_id: jobId });
    }
    await env.TOOLKITS_BUCKET.delete(`telegram-batch/${batchId}.json`);
    await sendMessage(env, chatId, `${batch.job_ids.length}টা ভিডিওর Audio (MP3/WAV) বানানো হচ্ছে...`);
  } else if (data.startsWith("dlmeta_edit:")) {
    const jobId = data.replace("dlmeta_edit:", "");
    const metaKey = `telegram-meta/${chatId}.json`;
    const state: MetaState = { stage: "awaiting_title", source: "cached", job_id: jobId, timestamp: Date.now() };
    await env.TOOLKITS_BUCKET.put(metaKey, JSON.stringify(state));
    await sendMessage(env, chatId, "নতুন Title (শিরোনাম) কী দিতে চাও, লিখে পাঠাও।");
  } else if (data.startsWith("dlmeta_skip:")) {
    await sendMessage(env, chatId, "ঠিক আছে, আগের ভার্সনটাই final থাকলো।");
  }
}

async function dispatchDownloadJob(
  env: Env,
  chatId: number,
  eventType: "fb_download" | "fb_audio" | "yt_download" | "yt_audio" | "meta_edit" | "meta_edit_cached",
  payload: Record<string, any>
) {
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
