# Social Transcriber

Paste an Instagram Reel or TikTok link, watch the video, then have Gemini
watch and listen to it for you — full timestamped transcript, a scene-by-scene
visual breakdown, on-screen text, and an explanation of what actually happens.

Gemini processes the video and its audio track together in a single call, so
the explanation can reference things a transcript alone would miss (a reaction
shot, a visual gag, a caption on screen).

---

## How it works

```
link ──▶ yt-dlp ──▶ /tmp/<id>/source.mp4 ──▶ ffmpeg (only if oversized)
                            │
                            ├──▶ GET /api/media/<id>   → <video> preview in the browser
                            │
                            └──▶ Gemini Files API ──▶ interactions.create
                                                            │
                                                            ▼
                                            structured JSON (transcript,
                                            scenes, on-screen text, summary)
```

Two steps on purpose: you confirm the right clip came down **before** spending
a model call on it.

### Routes

| Route | What it does |
| --- | --- |
| `POST /api/fetch` | `{ url }` → downloads the clip, returns `{ id, mediaUrl, source }` |
| `GET /api/media/[id]` | Streams the downloaded clip, with HTTP Range support so the player can seek |
| `POST /api/analyze` | `{ id }` → streams NDJSON progress events, ends with the full analysis |
| `POST /api/transcribe` | `{ url }` → does both steps in one call and returns JSON. For scripts, not the UI |

Downloaded clips live in the OS temp directory and are swept after
`CLIP_TTL_MINUTES` (default 30).

---

## Running locally

```bash
npm install
cp .env.example .env.local     # then paste your Gemini API key into it
npm run dev
```

Open http://localhost:3000.

You also need **ffmpeg** on your PATH if you want oversized clips downscaled
before upload — it is optional, and the app silently skips compression when
ffmpeg is missing.

```bash
brew install ffmpeg            # macOS
```

`npm install` makes `yt-dlp-exec` fetch the yt-dlp binary into
`node_modules/yt-dlp-exec/bin`. The app finds it there automatically. To use a
different copy, set `YTDLP_PATH`.

One-shot from the terminal:

```bash
curl -X POST localhost:3000/api/transcribe \
  -H 'content-type: application/json' \
  -d '{"url":"https://www.tiktok.com/@user/video/1234567890"}'
```

---

## Deploying

### Can this go on Vercel?

**Not as it stands, no.** Function duration is fine (300s on Hobby, up to 800s
on Pro), but four other things break:

1. **The filesystem isn't shared between invocations.** `/api/fetch` writes the
   clip to `/tmp`, then `/api/media` and `/api/analyze` run as *separate*
   invocations that may land on a different instance with a different, empty
   `/tmp`. The preview-then-analyze flow depends on those three routes seeing
   the same file, and on Vercel they often won't.
2. **Responses are capped at 4.5 MB.** `/api/media` streams a video file
   through a function, and most Reels are bigger than that. The preview player
   simply won't work.
3. **yt-dlp is a Python program.** The binary `yt-dlp-exec` installs starts with
   `#!/usr/bin/env python3`, and Vercel's Node.js runtime has no Python. You'd
   have to bundle the self-contained `yt-dlp_linux` build (~30 MB), keep it
   executable through the build, and pull it into the function with
   `outputFileTracingIncludes`.
4. **No ffmpeg**, so oversized clips can't be downscaled before upload.

Even after solving all four, **Vercel's egress IPs are among the most
aggressively blocked by Instagram and TikTok** — you would be fighting
`login required` and `IP address is blocked` constantly.

If you want Vercel specifically, the workable shape is: Vercel hosts only the
frontend, and the download + Gemini work moves to a small container service
elsewhere that the frontend calls. That's more moving parts than just hosting
the whole thing in a container.

### What to use instead

Any host that runs a container with a normal filesystem. The included
`Dockerfile` covers all of them:

```bash
docker build -t social-transcriber .
docker run -p 3000:3000 -e GEMINI_API_KEY=... social-transcriber
```

| Host | Notes |
| --- | --- |
| **Railway** | Easiest. Detects the Dockerfile, deploys on push. Good default choice |
| **Render** | Same idea, generous free tier, cold starts on the free plan |
| **Fly.io** | Cheapest at small scale, and lets you pick a region whose IPs are less burnt |
| **Any VPS** (Hetzner, DigitalOcean) | Best option if you're getting blocked — a fresh, dedicated IP is worth more than anything else here |

Set `GEMINI_API_KEY` in the host's environment variables. Everything else is
optional.

---

## When downloads fail

This is the part that will actually give you trouble — not the AI.

Instagram and TikTok both fingerprint and block datacenter IP ranges, and they
change their APIs often. In rough order of effectiveness:

1. **Use a residential proxy.** Set `YTDLP_PROXY=http://user:pass@host:port`.
   This fixes the majority of `IP address is blocked` and `login required`
   errors, because the request stops looking like it came from a server farm.
2. **Supply cookies.** Export `cookies.txt` in Netscape format from a browser
   logged into Instagram, put it in the project root (or point `COOKIES_FILE`
   at it). Required for anything private or age-restricted. Use a throwaway
   account — heavy automated use can get an account restricted.
3. **Keep yt-dlp current.** When a platform changes something, yt-dlp usually
   ships a fix within days. A stale binary is the most common cause of sudden
   breakage. `npm update yt-dlp-exec` locally, or rebuild the Docker image.
4. **Self-host on a fresh IP.** A new VPS IP is far less likely to be on a
   blocklist than a shared cloud one.

Private accounts and deleted posts cannot be downloaded at all, cookies or not.

---

## Cost

**There is a free tier**, and for testing you will almost certainly stay inside
it. Get a key at https://aistudio.google.com/apikey — no credit card. Your
current rate limits are shown at https://aistudio.google.com/rate-limit; they
change often, so read them there rather than trusting any number written down
here. The one thing worth knowing: **free tier content is used to improve
Google's products.** Don't run anything sensitive through it.

If you outgrow the free tier, video is token-heavy — roughly 300 tokens per
second of footage at default resolution, including audio. A 30-second Reel is
on the order of 9-10k input tokens plus a couple of thousand output tokens,
which on `gemini-3.5-flash` at $1.50/M in and $9.00/M out works out around
three or four cents per video. Check https://ai.google.dev/pricing for current
numbers.

---

## Configuration

See `.env.example`. Everything except `GEMINI_API_KEY` has a sensible default.

---

## A note on what you're allowed to do with this

Downloading videos is against both platforms' terms of service, and the videos
themselves belong to the people who made them. Transcribing something for your
own research or accessibility is a very different thing from republishing it.
Worth being deliberate about which one you're doing.
