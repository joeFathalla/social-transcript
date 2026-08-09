# Deploying to Railway

About 15 minutes, most of it waiting for the first build.

Railway detects the `Dockerfile`, builds it, injects a `PORT` the app already
honours, and hands you an HTTPS URL. `railway.json` in the repo root sets the
health check and restart policy, so there's nothing to configure in the
dashboard beyond environment variables.

---

## What it costs

Railway has a **30-day trial**, not a free tier: a one-time **$5 credit**,
1 GB RAM, shared vCPU. When the $5 or the 30 days runs out, the account drops
to the Free plan — $1 of credit a month, which won't keep a container running.
After that it's $5/month for Hobby.

Enable **app sleeping** (step 5) and the $5 stretches a long way, because the
clock stops while nothing is hitting it.

---

## 1. Push to GitHub

Railway builds from a Git repo.

```bash
cd ~/Documents/Joe/projects/social-transcriber

# Confirm your API key is not about to be committed — this must print a line
git check-ignore -v .env.local

git add -A
git commit -m "Social Transcriber"
gh repo create social-transcriber --private --source=. --push
```

No `gh`? Create an empty repo at https://github.com/new (no README, no
.gitignore), then:

```bash
git remote add origin https://github.com/<you>/social-transcriber.git
git branch -M main
git push -u origin main
```

---

## 2. Create the service

1. Go to https://railway.com and **sign in with GitHub**.

   **Let Railway verify the account.** Unverified trial accounts get
   *restricted outbound network access and only a limited set of ports* — which
   breaks yt-dlp completely. Downloads will fail with confusing errors and
   you'll have no idea why. Signing in with GitHub is what does the verifying.

2. **New Project → Deploy from GitHub repo** → pick `social-transcriber`.

Railway finds the `Dockerfile` and starts building immediately. It will fail
its health check on this first attempt — the Gemini key isn't set yet. That's
expected; carry on.

---

## 3. Set the environment variables

Generate an API key first, on your Mac:

```bash
openssl rand -hex 32
```

Then in Railway: your service → **Variables** → add these.

| Variable | Value |
| --- | --- |
| `GEMINI_API_KEY` | your key from https://aistudio.google.com/apikey |
| `API_KEY` | the `openssl` output — this is what n8n will send |
| `MAX_FILESIZE_MB` | `80` |
| `COMPRESS_ABOVE_MB` | `999` |
| `CLIP_TTL_MINUTES` | `15` |

The last three are tuning for a 1 GB shared-vCPU container: ffmpeg re-encoding
would take minutes on this hardware, so it's better to skip compression and
upload the larger file — Gemini doesn't mind.

**`API_KEY` is not optional in practice.** Without it, `/api/transcribe` is
open to anyone who finds the URL, and every call spends your Gemini quota.

Leave `N8N_WEBHOOK_URL` out for now — step 7.

---

## 4. Generate a public URL

**Settings → Networking → Generate Domain.**

Railway exposes nothing by default. Skip this and you'll have a perfectly
healthy service you cannot reach — a genuinely confusing ten minutes.

You get something like `social-transcriber-production.up.railway.app`.

---

## 5. Enable app sleeping (optional, recommended on the trial)

**Settings → enable app sleeping.** The service suspends when idle and wakes on
the next request. Costs you a cold start of a few seconds; saves most of your
$5.

---

## 6. Verify

```bash
curl -s https://YOUR-APP.up.railway.app/api/health | jq
```

```json
{
  "status": "ok",
  "checks": { "geminiApiKey": "set", "ytdlp": "ok (2026.07.xx)" },
  "config": {
    "model": "gemini-3.5-flash",
    "apiAuth": "enabled",
    "notionWebhook": "not configured",
    "downloadAttempts": 5
  }
}
```

If `status` is `degraded`, the `checks` block says which piece is missing.
`apiAuth: "OPEN"` means you skipped `API_KEY` — go back and set it.

Then check the auth actually bites:

```bash
# expect 401
curl -s -o /dev/null -w '%{http_code}\n' \
  -X POST https://YOUR-APP.up.railway.app/api/transcribe \
  -H 'content-type: application/json' \
  -d '{"url":"https://www.tiktok.com/@a/video/1"}'
```

And a real run — **TikTok first**, it tolerates datacenter IPs better than
Instagram:

```bash
curl -sS -X POST https://YOUR-APP.up.railway.app/api/transcribe \
  -H 'content-type: application/json' \
  -H 'X-API-Key: your-api-key' \
  -d '{"url":"https://www.tiktok.com/@user/video/1234567890"}' | jq '.result.title, .text.transcript'
```

Open the URL in a browser too — the web UI is there for eyeballing a video
before spending a model call.

---

## 7. Connect n8n

Give whoever builds the workflow three things: the base URL, the `API_KEY`, and
**[`API.md`](./API.md)**.

**n8n → app.** An **HTTP Request** node:

- Method `POST`, URL `https://YOUR-APP.up.railway.app/api/transcribe`
- Header `X-API-Key: <the key>`
- Body `{ "url": "{{ $json.url }}" }`
- **Timeout: 180000 ms.** The default aborts a request that would have
  succeeded. This is the single most likely thing to waste an afternoon.

The response includes a `text` object with the transcript and scenes already
joined into strings — no Code node needed just to flatten arrays.

**app → n8n.** For the **Send to Notion** button in the UI: build a Webhook
node in n8n, copy its production URL, and add it to Railway's Variables as
`N8N_WEBHOOK_URL`. Optionally set `N8N_WEBHOOK_SECRET` too, and have the
workflow reject anything without a matching `X-Webhook-Secret` header.

Changing variables triggers a redeploy automatically.

---

## Day to day

- **Logs:** service → **Deployments** → the active one → logs. Every "Couldn't
  download the video" the UI shows has its real cause here.
- **Deploy an update:** `git push`. Railway rebuilds on every push to `main`.
- **Redeploy unchanged:** the ⋮ menu → Redeploy. Do this every few weeks —
  it rebuilds with a current yt-dlp, which is the fix for "it worked last
  month".

---

## If something goes wrong

| Symptom | Cause | Fix |
| --- | --- | --- |
| Health check fails, deploy marked crashed | `GEMINI_API_KEY` missing | Variables → add it. `/api/health` says which check failed |
| Can't reach the app at all | No public domain | Settings → Networking → **Generate Domain** |
| Every download fails, odd network errors | Unverified Railway account — restricted egress | Sign in with GitHub and complete verification |
| `401` from `/api/transcribe` | Wrong header | `X-API-Key: <key>` or `Authorization: Bearer <key>` |
| n8n request times out around 30–60s | Node timeout too low | Set it to 180000 ms |
| Instagram always fails, TikTok works | Railway's IP is blocked by Instagram | Expected. Cookies or a residential proxy — see the README |
| Build fails on `npm ci` | Lockfile out of sync | `npm install` locally, commit `package-lock.json`, push |
| First request after idle is slow | App sleeping | Working as configured |

---

## One structural caveat

**Keep this at one replica.** The three web UI routes (`/api/fetch`,
`/api/media`, `/api/analyze`) share a downloaded video on the container's local
disk. Scale to two replicas and the analyse call can land on an instance where
the file doesn't exist, producing confusing "clip expired" errors.

`/api/transcribe` — the one n8n uses — is unaffected. It does the download and
the analysis inside a single request, so it never depends on shared state. If
you ever do need to scale, that endpoint scales freely and only the browser UI
needs rethinking.
