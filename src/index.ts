// LofiMellowBot Telegram Webhook Handler — v19
// v2-v18: see earlier version history (pairing loop, FB/YT/X downloaders,
// /meta, /trim, /toaudio, /checkmusic via AudD).
// v19 adds: (1) generic "any website" video downloader as a fallback when a
// link doesn't match Facebook/YouTube/X — powered by yt-dlp, works on
// Instagram/TikTok/Vimeo/etc; (2) an audio mastering button (loudness
// normalization + light compression + EQ boost via ffmpeg) offered
// alongside metadata-edit/copyright-check after any audio is produced.
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

type Platform = "fb" | "yt" | "x" | "generic";

type PendingState = {
  type: "video" | "audio";
  input_key?: string;
  drive_id?: string;
  target_minutes: number;
  timestamp: number;
};

type BatchState = {
  chat_id: number;
  platform: Platform;
  job_ids: string[];
};

type ReplyThread = {
  flow: "meta" | "trim" | "checkmusic" | "toaudio";
  stage: "awaiting_file" | "awaiting_title" | "awaiting_filename" | "awaiting_range";
  source?: "upload" | "cached";
  input_key?: string;
  ext?: string;
  is_video?: boolean;
  job_id?: string;
  title?: string;
  timestamp: number;
};

const PENDING_TTL_MS = 15 * 60 * 1000;
const THREAD_TTL_MS = 30 * 60 * 1000;

const PLATFORM_LABEL: Record<Platform, string> = {
  fb: "ফেসবুক",
  yt: "ইউটিউব",
  x: "এক্স (Twitter)",
  generic: "এই ওয়েবসাইট",
};

const DOWNLOAD_EVENT: Record<Platform, string> = {
  fb: "fb_download",
  yt: "yt_download",
  x: "x_download",
  generic: "generic_download",
};

const AUDIO_EVENT: Record<Platform, string> = {
  fb: "fb_audio",
  yt: "yt_audio",
  x: "x_audio",
  generic: "generic_audio",
};

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

    if (message.reply_to_message?.message_id) {
      const handled = await handleThreadReply(env, chatId, message, message.reply_to_message.message_id);
      if (handled) return new Response("ok");
    }

    if (message.text?.trim() === "/start") {
      await sendMessage(env, chatId,
        "Send me a short video (mp4) and a short/long audio (mp3 file or Google Drive link) — in either order. " +
        "I'll wait for both and combine them into one seamless long loop. " +
        "Or send just one of them and type /skip to process it alone (video gets no audio, audio loops on its own). " +
        "Caption a file with a number (minutes) to set duration, default 120. " +
        "\n\nYou can also paste one or more Facebook, YouTube, X (Twitter), or any other video link — I'll send each video back directly, with options to convert to MP3/WAV, edit metadata, check copyright, or master the audio." +
        "\n\nType /meta to edit a file's title and filename yourself. Type /trim to cut a specific second-range out of a file. Type /checkmusic to upload an audio file and check if it matches an already-distributed track. Type /toaudio to upload a video and get it converted to MP3/WAV directly. " +
        "\n\nImportant: when I ask for a title, filename, or time range, always use Telegram's Reply on that exact message — this keeps multiple files from getting mixed up.");
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

    if (message.text?.trim() === "/meta") {
      const messageId = await sendForceReply(env, chatId, "ফাইল পাঠাও (audio অথবা video) — এই মেসেজে Reply করে পাঠাও।");
      if (messageId) {
        const thread: ReplyThread = { flow: "meta", stage: "awaiting_file", source: "upload", timestamp: Date.now() };
        await env.TOOLKITS_BUCKET.put(`telegram-editthread/${chatId}-${messageId}.json`, JSON.stringify(thread));
      }
      return new Response("ok");
    }

    if (message.text?.trim() === "/trim") {
      const messageId = await sendForceReply(env, chatId, "যে ফাইলটা ট্রিম করতে চাও সেটা পাঠাও (audio অথবা video) — এই মেসেজে Reply করে পাঠাও।");
      if (messageId) {
        const thread: ReplyThread = { flow: "trim", stage: "awaiting_file", timestamp: Date.now() };
        await env.TOOLKITS_BUCKET.put(`telegram-editthread/${chatId}-${messageId}.json`, JSON.stringify(thread));
      }
      return new Response("ok");
    }

    if (message.text?.trim() === "/checkmusic") {
      const messageId = await sendForceReply(env, chatId, "যে অডিও ফাইলটা কপিরাইট/ডিস্ট্রিবিউশন চেক করতে চাও সেটা পাঠাও — এই মেসেজে Reply করে পাঠাও (যেকোনো সাইজ ঠিক আছে)।");
      if (messageId) {
        const thread: ReplyThread = { flow: "checkmusic", stage: "awaiting_file", timestamp: Date.now() };
        await env.TOOLKITS_BUCKET.put(`telegram-editthread/${chatId}-${messageId}.json`, JSON.stringify(thread));
      }
      return new Response("ok");
    }

    if (message.text?.trim() === "/toaudio") {
      const messageId = await sendForceReply(env, chatId, "যে ভিডিওটা অডিওতে কনভার্ট করতে চাও সেটা পাঠাও — এই মেসেজে Reply করে পাঠাও।");
      if (messageId) {
        const thread: ReplyThread = { flow: "toaudio", stage: "awaiting_file", timestamp: Date.now() };
        await env.TOOLKITS_BUCKET.put(`telegram-editthread/${chatId}-${messageId}.json`, JSON.stringify(thread));
      }
      return new Response("ok");
    }

    // --- Facebook video link handling ---
    if (message.text && (message.text.includes("facebook.com") || message.text.includes("fb.watch"))) {
      const urls = Array.from(message.text.matchAll(/https?:\/\/\S+/g)).map((m: any) => m[0]);
      if (urls.length > 0) {
        await handleMultiDownload(env, chatId, "fb", urls);
        return new Response("ok");
      }
    }

    // --- YouTube video link handling ---
    if (message.text && (message.text.includes("youtube.com") || message.text.includes("youtu.be"))) {
      const urls = Array.from(message.text.matchAll(/https?:\/\/\S+/g)).map((m: any) => m[0]);
      if (urls.length > 0) {
        await handleMultiDownload(env, chatId, "yt", urls);
        return new Response("ok");
      }
    }

    // --- X (Twitter) video link handling ---
    if (message.text && (message.text.includes("twitter.com") || message.text.includes("x.com"))) {
      const urls = Array.from(message.text.matchAll(/https?:\/\/\S+/g)).map((m: any) => m[0]);
      if (urls.length > 0) {
        await handleMultiDownload(env, chatId, "x", urls);
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

    // --- Generic fallback: any other website link (yt-dlp supported sites) ---
    if (message.text) {
      const genericUrls = Array.from(message.text.matchAll(/https?:\/\/\S+/g)).map((m: any) => m[0]);
      if (genericUrls.length > 0) {
        await handleMultiDownload(env, chatId, "generic", genericUrls);
        return new Response("ok");
      }
    }

    const file = message.audio || message.video || message.document;
    if (!file) {
      await sendMessage(env, chatId, "Please send an audio/video file, a Google Drive link for audio, or any video link. Or type /meta, /trim, /checkmusic, or /toaudio.");
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

// --- Downloader helpers (shared by Facebook, YouTube, X, generic) ---

async function handleMultiDownload(env: Env, chatId: number, platform: Platform, urls: string[]) {
  const jobIds: string[] = [];
  const downloadEvent = DOWNLOAD_EVENT[platform];
  const platformLabel = PLATFORM_LABEL[platform];

  for (const url of urls) {
    const jobId = crypto.randomUUID();
    jobIds.push(jobId);
    await dispatchDownloadJob(env, chatId, downloadEvent, { url, job_id: jobId });
  }

  if (urls.length === 1) {
    await sendMessage(env, chatId, `${platformLabel} থেকে ভিডিও ডাউনলোড হচ্ছে, একটু অপেক্ষা করো...`);
    return;
  }

  const batchId = crypto.randomUUID();
  const batch: BatchState = { chat_id: chatId, platform, job_ids: jobIds };
  await env.TOOLKITS_BUCKET.put(`telegram-batch/${batchId}.json`, JSON.stringify(batch));

  await sendMessage(env, chatId, `${urls.length}টা ভিডিও ডাউনলোড হচ্ছে, একটু অপেক্ষা করো...`);

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
  } else if (data.startsWith("x_audio:")) {
    const jobId = data.replace("x_audio:", "");
    await dispatchDownloadJob(env, chatId, "x_audio", { job_id: jobId });
    await sendMessage(env, chatId, "অডিও (MP3/WAV) বানানো হচ্ছে...");
  } else if (data.startsWith("generic_audio:")) {
    const jobId = data.replace("generic_audio:", "");
    await dispatchDownloadJob(env, chatId, "generic_audio", { job_id: jobId });
    await sendMessage(env, chatId, "অডিও (MP3/WAV) বানানো হচ্ছে...");
  } else if (data.startsWith("batch_audio:")) {
    const batchId = data.replace("batch_audio:", "");
    const obj = await env.TOOLKITS_BUCKET.get(`telegram-batch/${batchId}.json`);
    if (!obj) {
      await sendMessage(env, chatId, "এই ব্যাচটা আর খুঁজে পাওয়া যাচ্ছে না।");
      return;
    }
    const batch: BatchState = JSON.parse(await obj.text());
    const audioEvent = AUDIO_EVENT[batch.platform];
    for (const jobId of batch.job_ids) {
      await dispatchDownloadJob(env, chatId, audioEvent, { job_id: jobId });
    }
    await env.TOOLKITS_BUCKET.delete(`telegram-batch/${batchId}.json`);
    await sendMessage(env, chatId, `${batch.job_ids.length}টা ভিডিওর Audio (MP3/WAV) বানানো হচ্ছে...`);
  } else if (data.startsWith("dlmeta_edit:")) {
    const jobId = data.replace("dlmeta_edit:", "");
    const messageId = await sendForceReply(env, chatId, "নতুন Title (শিরোনাম) কী দিতে চাও — এই মেসেজে Reply করে লিখে পাঠাও।");
    if (messageId) {
      const thread: ReplyThread = { flow: "meta", stage: "awaiting_title", source: "cached", job_id: jobId, timestamp: Date.now() };
      await env.TOOLKITS_BUCKET.put(`telegram-editthread/${chatId}-${messageId}.json`, JSON.stringify(thread));
    }
  } else if (data.startsWith("dlmeta_skip:")) {
    await sendMessage(env, chatId, "ঠিক আছে, আগের ভার্সনটাই final থাকলো।");
  } else if (data.startsWith("copyright_check:")) {
    const jobId = data.replace("copyright_check:", "");
    await sendMessage(env, chatId, "কপিরাইট/ডিস্ট্রিবিউশন চেক করা হচ্ছে, একটু অপেক্ষা করো...");
    await dispatchDownloadJob(env, chatId, "copyright_check_run", { r2_key: `audio-cache/${jobId}.mp3` });
  } else if (data.startsWith("audio_master:")) {
    const jobId = data.replace("audio_master:", "");
    await sendMessage(env, chatId, "অডিও মাস্টারিং (লাউডনেস/কোয়ালিটি বুস্ট) করা হচ্ছে, একটু অপেক্ষা করো...");
    await dispatchDownloadJob(env, chatId, "audio_master_run", { r2_key: `audio-cache/${jobId}.mp3` });
  }
}

// --- Reply-thread handling (shared by /meta, /trim, /checkmusic, /toaudio) ---

async function handleThreadReply(env: Env, chatId: number, message: any, repliedToMessageId: number): Promise<boolean> {
  const key = `telegram-editthread/${chatId}-${repliedToMessageId}.json`;
  const obj = await env.TOOLKITS_BUCKET.get(key);
  if (!obj) return false;

  let thread: ReplyThread;
  try {
    thread = JSON.parse(await obj.text());
  } catch {
    return false;
  }
  if (Date.now() - thread.timestamp > THREAD_TTL_MS) {
    await env.TOOLKITS_BUCKET.delete(key);
    await sendMessage(env, chatId, "এই সেশনের মেয়াদ শেষ হয়ে গেছে, আবার শুরু করো।");
    return true;
  }

  if (thread.stage === "awaiting_file") {
    const file = message.audio || message.video || message.document;
    if (!file) {
      await sendMessage(env, chatId, "এটা কোনো ফাইল না মনে হচ্ছে। এই মেসেজে Reply করেই audio/video ফাইল পাঠাও।");
      return true;
    }
    const isVideo = !!message.video || (message.document?.mime_type?.startsWith("video/"));
    try {
      const fileInfoRes = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getFile?file_id=${file.file_id}`);
      const fileInfo: any = await fileInfoRes.json();
      if (!fileInfo.ok) {
        await sendMessage(env, chatId, "ফাইলটা নিতে সমস্যা হয়েছে (হয়তো ২০MB-র বেশি)। আবার চেষ্টা করো।");
        await env.TOOLKITS_BUCKET.delete(key);
        return true;
      }
      const telegramFileUrl = `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${fileInfo.result.file_path}`;
      const fileBytes = await (await fetch(telegramFileUrl)).arrayBuffer();
      const ext = isVideo ? "mp4" : "mp3";
      const inputKey = `telegram-inputs/${chatId}-${Date.now()}.${ext}`;
      await env.TOOLKITS_BUCKET.put(inputKey, fileBytes);
      await env.TOOLKITS_BUCKET.delete(key);

      if (thread.flow === "meta") {
        const newMessageId = await sendForceReply(env, chatId, "ফাইল পেয়েছি। নতুন Title (শিরোনাম) কী দিতে চাও — এই মেসেজে Reply করে লিখে পাঠাও।");
        if (newMessageId) {
          const next: ReplyThread = {
            flow: "meta", stage: "awaiting_title", source: "upload",
            input_key: inputKey, ext, is_video: isVideo, timestamp: Date.now(),
          };
          await env.TOOLKITS_BUCKET.put(`telegram-editthread/${chatId}-${newMessageId}.json`, JSON.stringify(next));
        }
      } else if (thread.flow === "trim") {
        const newMessageId = await sendForceReply(env, chatId,
          "ফাইল পেয়েছি। কোন সেকেন্ড থেকে কোন সেকেন্ড পর্যন্ত বাদ দিবে? এই মেসেজে Reply করে লিখো, যেমন: 10-25");
        if (newMessageId) {
          const next: ReplyThread = {
            flow: "trim", stage: "awaiting_range",
            input_key: inputKey, ext, is_video: isVideo, timestamp: Date.now(),
          };
          await env.TOOLKITS_BUCKET.put(`telegram-editthread/${chatId}-${newMessageId}.json`, JSON.stringify(next));
        }
      } else if (thread.flow === "checkmusic") {
        if (isVideo) {
          await sendMessage(env, chatId, "এটা video ফাইল মনে হচ্ছে। /checkmusic শুধু audio ফাইলের জন্য — audio (mp3/wav) পাঠাও।");
          return true;
        }
        await sendMessage(env, chatId, "কপিরাইট/ডিস্ট্রিবিউশন চেক করা হচ্ছে, একটু অপেক্ষা করো...");
        await dispatchDownloadJob(env, chatId, "copyright_check_run", { r2_key: inputKey });
      } else if (thread.flow === "toaudio") {
        if (!isVideo) {
          await sendMessage(env, chatId, "এটা তো ইতিমধ্যে audio ফাইল, কনভার্ট করার দরকার নেই।");
          return true;
        }
        const jobId = crypto.randomUUID();
        await dispatchDownloadJob(env, chatId, "video_to_audio", { input_key: inputKey, ext, job_id: jobId });
        await sendMessage(env, chatId, "ভিডিও থেকে অডিও বানানো হচ্ছে, একটু অপেক্ষা করো...");
      }
    } catch (err: any) {
      await sendMessage(env, chatId, "Something went wrong: " + err.message);
      await env.TOOLKITS_BUCKET.delete(key);
    }
    return true;
  }

  if (thread.stage === "awaiting_title") {
    if (!message.text) {
      await sendMessage(env, chatId, "এই মেসেজে Reply করে Title-টা টেক্সট আকারে লিখে পাঠাও।");
      return true;
    }
    const title = message.text.trim();
    await env.TOOLKITS_BUCKET.delete(key);

    const newMessageId = await sendForceReply(env, chatId, "ঠিক আছে। এখন নতুন ফাইলের নাম দাও (extension ছাড়া, শুধু নাম) — এই মেসেজে Reply করে।");
    if (newMessageId) {
      const next: ReplyThread = { ...thread, stage: "awaiting_filename", title, timestamp: Date.now() };
      await env.TOOLKITS_BUCKET.put(`telegram-editthread/${chatId}-${newMessageId}.json`, JSON.stringify(next));
    }
    return true;
  }

  if (thread.stage === "awaiting_filename") {
    if (!message.text) {
      await sendMessage(env, chatId, "এই মেসেজে Reply করে নতুন ফাইলের নাম টেক্সট আকারে লিখে পাঠাও।");
      return true;
    }
    const filename = message.text.trim().replace(/[\\/:*?"<>|]/g, "");
    await env.TOOLKITS_BUCKET.delete(key);

    if (thread.source === "cached") {
      await dispatchDownloadJob(env, chatId, "meta_edit_cached", { job_id: thread.job_id, title: thread.title, filename });
    } else {
      await dispatchDownloadJob(env, chatId, "meta_edit", {
        input_key: thread.input_key, ext: thread.ext, is_video: thread.is_video,
        title: thread.title, filename,
      });
    }
    await sendMessage(env, chatId, "মেটাডেটা পরিবর্তন হচ্ছে, একটু অপেক্ষা করো...");
    return true;
  }

  if (thread.stage === "awaiting_range") {
    if (!message.text) {
      await sendMessage(env, chatId, "এই মেসেজে Reply করে রেঞ্জ লিখো, যেমন: 10-25");
      return true;
    }
    const rangeMatch = message.text.match(/(\d+(?:\.\d+)?)\D+(\d+(?:\.\d+)?)/);
    if (!rangeMatch) {
      await sendMessage(env, chatId, "বুঝতে পারলাম না। এই ফরম্যাটে লিখো: 10-25 (শুরু-শেষ, সেকেন্ডে)।");
      return true;
    }
    const startSec = parseFloat(rangeMatch[1]);
    const endSec = parseFloat(rangeMatch[2]);
    if (endSec <= startSec) {
      await sendMessage(env, chatId, "শেষের সংখ্যাটা শুরুর সংখ্যার চেয়ে বড় হতে হবে। আবার লিখে Reply করো।");
      return true;
    }
    await env.TOOLKITS_BUCKET.delete(key);

    await dispatchDownloadJob(env, chatId, "trim_edit", {
      input_key: thread.input_key,
      ext: thread.ext,
      is_video: thread.is_video,
      start_sec: startSec,
      end_sec: endSec,
    });
    await sendMessage(env, chatId, `ঠিক আছে, ${startSec}s থেকে ${endSec}s পর্যন্ত অংশ বাদ দিয়ে বাকিটা জোড়া লাগানো হচ্ছে...`);
    return true;
  }

  return false;
}

async function dispatchDownloadJob(env: Env, chatId: number, eventType: string, payload: Record<string, any>) {
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

async function sendForceReply(env: Env, chatId: number, text: string): Promise<number | null> {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      reply_markup: { force_reply: true, selective: true },
    }),
  });
  try {
    const data: any = await res.json();
    return data?.result?.message_id ?? null;
  } catch {
    return null;
  }
}
