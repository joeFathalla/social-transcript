# Social Transcriber

Paste an Instagram Reel or TikTok link, watch the video, then have Gemini watch
and listen to it for you — full timestamped transcript, a scene-by-scene visual
breakdown, on-screen text, and an explanation of what actually happens.

Gemini processes the video and its audio track together in a single call, so
the explanation can reference things a transcript alone would miss (a reaction
shot, a visual gag, a caption on screen).

---

## How it works

```
link ──▶ yt-dlp ──▶ $TMPDIR/<id>/source.mp4 ──▶ ffmpeg (only if oversized)
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
a model call on it. That also catches the case where a download silently
returns a thumbnail or an error page instead of a video.

### Routes

| Route | What it does |
| --- | --- |
| `POST /api/fetch` | `{ url }` → downloads the clip, returns `{ id, mediaUrl, source }` |
| `GET /api/media/[id]` | Streams the downloaded clip, with HTTP Range support so the player can seek |
| `POST /api/analyze` | `{ id }` → streams NDJSON progress events, ends with the full analysis |
| `POST /api/transcribe` | `{ url }` → does both steps in one call and returns JSON. For scripts, not the UI |

Downloaded clips live in the temp directory and are swept after
`CLIP_TTL_MINUTES` (default 30).

---

## Running locally

```bash
npm install
cp .env.example .env.local     # then paste your Gemini API key into it
npm run dev
```

Open http://localhost:3000.

You also want **ffmpeg** on your PATH so oversized clips get downscaled before
upload — it's optional, and the app silently skips compression without it.

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

**See [`DEPLOY.md`](./DEPLOY.md).** Primary target is Koyeb — free, no credit
card, builds the `Dockerfile` from GitHub. Railway and Hugging Face Spaces are
covered there too; the same Dockerfile works on all three, since it binds
whatever `$PORT` the host injects and runs as uid 1000.

It needs a host with a normal filesystem. The three routes share a downloaded
file on local disk, so serverless platforms where each request may land on a
different instance (Vercel, Lambda) can't run the preview step.

```bash
docker build -t social-transcriber .
docker run -p 7860:7860 -e GEMINI_API_KEY=... social-transcriber
```

---

## When downloads fail

This is the part that will actually give you trouble — not the AI.

Instagram and TikTok both fingerprint and block datacenter IP ranges, and they
change their APIs often. In rough order of effectiveness:

1. **Use a residential proxy.** Set `YTDLP_PROXY=http://user:pass@host:port`.
   This fixes the majority of `IP address is blocked` and `login required`
   errors, because the request stops looking like it came from a server farm.
2. **Supply cookies.** Export `cookies.txt` in Netscape format from a browser
   logged into Instagram, and point `COOKIES_FILE` at it. Required for anything
   private or age-restricted. Use a throwaway account — heavy automated use can
   get an account restricted.
3. **Keep yt-dlp current.** When a platform changes something, yt-dlp usually
   ships a fix within days. A stale binary is the most common cause of sudden
   breakage. `npm update yt-dlp-exec` locally; redeploy in production.
4. **Run it locally instead.** Your home IP is residential, which is worth more
   than every other trick combined.

Private accounts and deleted posts cannot be downloaded at all, cookies or not.

---

## Cost

**There is a free Gemini tier**, and for testing you will almost certainly stay
inside it. Get a key at https://aistudio.google.com/apikey — no credit card.
Your current rate limits are shown at https://aistudio.google.com/rate-limit;
they change often, so read them there rather than trusting any number written
down here. The one thing worth knowing: **free tier content is used to improve
Google's products.** Don't run anything sensitive through it.

Past the free tier, video is token-heavy — roughly 300 tokens per second of
footage including audio. A 30-second Reel is around 9-10k input tokens plus a
couple of thousand output, which on `gemini-3.5-flash` at $1.50/M in and
$9.00/M out works out to three or four cents per video.

---

## Configuration

See `.env.example`. Everything except `GEMINI_API_KEY` has a sensible default.

---

## A note on what you're allowed to do with this

Downloading videos is against both platforms' terms of service, and the videos
themselves belong to the people who made them. Transcribing something for your
own research or accessibility is a very different thing from republishing it.
Worth being deliberate about which one you're doing.
