# toolkits-mcp — LofiMellowBot

A Telegram bot (@LofiMellowbot) that turns a short audio or video clip into
a long, seamless loop (crossfade-based, no audible/visible seam) and
replies with a download link.

Architecture: Telegram -> Cloudflare Worker (src/index.ts) -> GitHub Actions
(.github/workflows/telegram-loop.yml, streams output directly to R2) -> R2
(toolkits-assets bucket) -> Telegram reply with download link.

Send /start to the bot to begin. Send a short mp4/mp3, or paste a Google
Drive share link for long audio sources.
