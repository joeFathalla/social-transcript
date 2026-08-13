# Social Transcriber

Paste an Instagram Reel or TikTok video link and Gemini watches *and listens* to it —
returning a timestamped transcript, a scene-by-scene visual breakdown,
on-screen text, and a practical brief, guide, or reusable AI skill.

The video and its audio go to Gemini together in a single call, so the
analysis can reference things a transcript alone would miss: a reaction
shot, a visual gag, a caption burned into the frame.

Two ways in: a web UI for humans, and an authenticated JSON API for automation.

---

## The API (this is the part n8n uses)

```bash
curl -X POST https://your-app.up.railway.app/api/transcribe \
  -H 'content-type: application/json' \
  -H 'X-API-Key: your-key' \
  -d '{"url":"https://www.tiktok.com/@user/video/1234567890"}'
```

Link in, complete analysis out, one request. Full contract in
**[`docs/API.md`](./docs/API.md)** — hand that file to whoever builds the
workflow.

| Route | Auth | Purpose |
| --- | --- | --- |
| `POST /api/transcribe` | **API key** | Everything in one call. For n8n |
| `GET /api/health` | none | Deploy check — reports what's configured |
| `POST /api/fetch` | none | Web UI: download a clip, stream retry progress |
| `GET /api/media/[id]` | none | Web UI: stream the clip for the preview player |
| `POST /api/analyze` | none | Web UI: analyse a fetched clip, stream progress |
| `POST /api/send-to-notion` | none | Web UI: push a finished analysis to an n8n webhook |

---

## How it works

```
link ──▶ yt-dlp (retries transient failures) ──▶ temp file ──▶ ffmpeg if oversized
                            │
                            ├──▶ /api/media/<id>  → preview player in the browser
                            │
                            └──▶ Gemini Files API ──▶ interactions.create
                                                            │
                                                            ▼
                                            structured JSON — transcript,
                                            scenes, on-screen text, brief
```

The web UI splits this into two steps on purpose: you confirm the right clip
came down **before** spending a model call on it. That also catches downloads
that silently return a thumbnail instead of a video. `/api/transcribe` does
both steps in one request, because automation has no one to look at a preview.

---

## Running locally

```bash
npm install
cp .env.example .env.local     # paste your Gemini API key into it
npm run dev
```

http://localhost:3000

You also need **yt-dlp** on your PATH, and want **ffmpeg**:

```bash
brew install yt-dlp ffmpeg
```

yt-dlp does the downloading and is required. ffmpeg only downscales oversized
clips before upload — the app skips compression silently without it.

Deliberately not an npm dependency: the popular wrapper needs a `python` binary
at install time (which breaks `npm ci` in a clean Node image) and pins an older
yt-dlp than brew gives you. Point `YTDLP_PATH` at a specific copy if you have
several. The Docker image installs it via pip.

---

## Deploying

**[`docs/RAILWAY.md`](./docs/RAILWAY.md)** — full walkthrough. Railway builds
the `Dockerfile`, injects `PORT`, and gives you a public HTTPS URL.

It needs a host with a normal filesystem and a single instance: the three web
UI routes share a downloaded file on local disk, so platforms that spread
requests across instances can't run the preview step. `/api/transcribe` is
immune to this — it does everything inside one request.

---

## When downloads fail

This is what will actually give you trouble, not the AI. Instagram and TikTok
fingerprint and block datacenter IPs, and change their APIs often.

Transient failures retry automatically — up to 5 attempts with 1/2/3/4-second
backoff — and the UI shows which attempt it's on. Permanent ones (private post,
deleted post, bad URL) fail immediately rather than wasting fifteen seconds.

When it's consistently failing, in order of effectiveness:

1. **A residential proxy.** `YTDLP_PROXY=http://user:pass@host:port`. Fixes
   most `IP address is blocked` and `login required` errors.
2. **Cookies.** Export `cookies.txt` (Netscape format) from a browser logged
   into Instagram and point `COOKIES_FILE` at it. Required for anything
   age-restricted. Use a throwaway account.
3. **Redeploy** to pick up a current yt-dlp. A stale binary is the most common
   cause of something that worked last month breaking today.

Private accounts and deleted posts can't be downloaded at all.

The browser only ever shows a generic "Couldn't download the video". The real
reason is in the server logs — that's deliberate.

---

## Cost

**Gemini has a real free tier, no credit card** —
https://aistudio.google.com/apikey. Rate limits are at
https://aistudio.google.com/rate-limit and change often, so read them there.
Testing won't come close to the limits.

Note that **free tier content is used to improve Google's products**. Fine for
public TikToks; think twice about anything private.

Paid, a 30-second video is roughly three or four cents on `gemini-3.5-flash`.
Video is token-heavy — about 300 tokens per second of footage.

---

## Configuration

See `.env.example`. Only `GEMINI_API_KEY` is required; everything else has a
sensible default.

---

## A note on what you're allowed to do with this

Downloading videos is against both platforms' terms of service, and the videos
belong to the people who made them. Transcribing something for your own
research or accessibility is a very different thing from republishing it.
Worth being deliberate about which one you're doing.
