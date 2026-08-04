# Deploying

Primary target: **Koyeb** — free, no credit card, builds your Dockerfile from
GitHub. A Hugging Face Spaces section follows; the same Dockerfile works for
both.

---

# Koyeb

## What you get on the free tier

| | |
| --- | --- |
| **Instance** | 0.1 vCPU, 512 MB RAM, 2 GB SSD |
| **Cost** | Free, no credit card (Koyeb may ask for one only if it can't verify you're human) |
| **Limit** | One free service per account |
| **Regions** | Frankfurt or Washington D.C. — pick **Frankfurt** |
| **Sleep** | Scales to zero after 1 hour with no traffic. First request after that is slow |

Set expectations honestly: **0.1 vCPU is slow.** Downloads and page loads will
feel sluggish, and the first request after a sleep can take 30+ seconds. The
Gemini call itself is unaffected — that's network wait, not CPU. It's fine for
testing; it is not something you'd put in front of users.

---

## 1. Push to GitHub

Koyeb builds from a Git repo, so the project needs to be on GitHub.

```bash
cd ~/Documents/Joe/projects/social-transcriber

# Confirm your API key won't be committed — this should print a line
git check-ignore -v .env.local

git add -A
git commit -m "Social Transcriber: Gemini video analysis"
```

Create the repo and push. With the GitHub CLI:

```bash
gh repo create social-transcriber --private --source=. --push
```

Without it, make an empty repo at https://github.com/new (no README, no
.gitignore), then:

```bash
git remote add origin https://github.com/<your-username>/social-transcriber.git
git branch -M main
git push -u origin main
```

---

## 2. Create the Koyeb service

1. Sign up at https://www.koyeb.com with your GitHub account.
2. **Create Web Service** → **GitHub** → authorize → pick `social-transcriber`,
   branch `main`.
3. **Builder:** choose **Dockerfile**. Koyeb defaults to Buildpacks, which will
   *not* work here — the app needs ffmpeg and yt-dlp, and only the Dockerfile
   installs them. This is the single easiest thing to get wrong.
4. **Instance:** **Free**. **Region:** **Frankfurt**.
5. **Exposed port:** set it to **7860** to match the Dockerfile's `EXPOSE`.
   (Koyeb defaults to 8000. That also works, because Koyeb injects a `PORT`
   variable that overrides the image's default and the app reads it — but
   matching keeps things unsurprising.)
6. **Environment variables** — add these:

   | Name | Value | Type | Why |
   | --- | --- | --- | --- |
   | `GEMINI_API_KEY` | your key | **Secret** | Required |
   | `COMPRESS_ABOVE_MB` | `999` | Plain | Effectively disables ffmpeg re-encoding. On 0.1 vCPU it would take minutes; better to upload the bigger file and let Gemini deal with it |
   | `MAX_FILESIZE_MB` | `60` | Plain | Keeps clips inside the 2 GB disk and the upload quick |
   | `CLIP_TTL_MINUTES` | `15` | Plain | Sweeps downloaded clips off the small disk sooner |

7. **Deploy.**

First build takes 5-10 minutes — it's installing ffmpeg and yt-dlp into the
image. Later pushes to `main` redeploy automatically and reuse cached layers.

Your URL will look like `https://social-transcriber-<org>.koyeb.app`.

---

## 3. Test it

Open the URL and try a **TikTok** link first — TikTok tolerates datacenter IPs
better than Instagram does.

If the video appears in the player, the hard part works. Then hit **Analyze
with Gemini**.

From the terminal:

```bash
curl -sS -X POST https://social-transcriber-<org>.koyeb.app/api/fetch \
  -H 'content-type: application/json' \
  -d '{"url":"https://www.tiktok.com/@user/video/1234567890"}'
```

A good response contains `"id"` and `"mediaUrl"`.

---

## 4. When something breaks

Koyeb's **Runtime logs** tab shows the real error behind whatever the UI said.

| What you see | What it means | Fix |
| --- | --- | --- |
| Build fails, no ffmpeg/yt-dlp in image | Koyeb used Buildpacks instead of the Dockerfile | Service settings → Builder → **Dockerfile** → redeploy |
| Health check fails / "service unhealthy" | Port mismatch | Service settings → Exposed port → `7860` |
| `Instagram refused to serve that video` | Koyeb's IP is blocked, or the post is private | Cookies (below), or accept Instagram wants a residential IP |
| `TikTok blocked this server's IP` | Same, TikTok's version | A proxy is the only real fix — set `YTDLP_PROXY` |
| `GEMINI_API_KEY is not set` | Secret missing or service not redeployed since adding it | Add it, then redeploy |
| `The model "…" isn't available on your key` | Key lacks that model | Add `GEMINI_MODEL` with one you do have |
| Out of memory / container killed | 512 MB is tight and a big clip pushed it over | Lower `MAX_FILESIZE_MB` to `40` |
| First request takes 30s+ | Scaled to zero after an hour idle | Not a bug |
| Downloads break months later | Stale yt-dlp | Redeploy — the image rebuilds with a current one |

### Adding Instagram cookies

Koyeb has no secret *files*, only environment variables, so a cookie file has
to be passed base64-encoded and decoded on startup. The app reads a file path,
not a blob, so that needs a few lines of code added — tell me and I'll wire it
up. Steps once it's in:

1. Export `cookies.txt` in Netscape format from a browser logged into Instagram
   (**use a throwaway account** — automated use can get an account restricted).
2. `base64 -i cookies.txt | pbcopy`
3. Add a Koyeb secret `COOKIES_B64` with that value.

Cookies expire; expect to redo this eventually.

---

# Alternative: Railway

Worth being precise about what "free" means here: Railway has a **30-day
trial**, not a free tier. You get a one-time **$5 credit**, 1 GB RAM and shared
vCPU, up to 5 services. When either the $5 or the 30 days runs out, the account
drops to the Free plan — **$1 of credit per month**, which will not keep a
container running. So: good for a few weeks of testing, then you either pay
$5/month for Hobby or move.

Specs are better than Koyeb's while it lasts (1 GB vs 512 MB, shared vCPU vs
0.1), so if you only need a couple of weeks it's the more pleasant option.

**Sign in with GitHub, and let Railway verify the account.** Unverified trial
accounts get *restricted outbound network access and only a limited set of
ports* — which breaks yt-dlp entirely. This is the one thing that will silently
sink you.

1. https://railway.com → sign in with GitHub.
2. **New Project → Deploy from GitHub repo** → pick `social-transcriber`.
   Railway detects the `Dockerfile` on its own; no builder setting to change.
3. **Variables** → add `GEMINI_API_KEY`, and `MAX_FILESIZE_MB=100`.
4. **Settings → Networking → Generate Domain.** Railway does *not* expose a
   public URL by default — skip this and you'll have a running service you
   cannot reach.
5. Optionally **Settings → enable app sleeping**, which stops the clock while
   idle and makes the $5 last much longer.

Railway injects `PORT`, which overrides the Dockerfile's default, and the app
reads it — nothing to configure.

---

# Alternative: Hugging Face Spaces

Better hardware for free — **2 vCPU and 16 GB RAM** — and no GitHub needed,
since Spaces are git repos hosted by Hugging Face. The trade-off is that it's
an ML-demo platform being used as a web host, and it needs one extra step.

### 1. Add the Spaces config block

Spaces reads its configuration from YAML front matter at the very top of
`README.md`. Paste this above everything else in that file:

```yaml
---
title: Social Transcriber
emoji: 🎬
colorFrom: indigo
colorTo: pink
sdk: docker
app_port: 7860
short_description: Transcribe and explain Instagram Reels and TikToks with Gemini
pinned: false
---
```

Without that block the Space won't know it's a Docker app. `app_port: 7860`
matches the Dockerfile's default `PORT`, so nothing else needs changing.

### 2. Create the Space and push

1. https://huggingface.co/new-space → name `social-transcriber` → **SDK:
   Docker → Blank** → **CPU basic (free)** → **Private** (this app downloads
   other people's copyrighted videos; private is the sensible default).
2. Push:

```bash
git add -A && git commit -m "Spaces config"
git remote add space https://huggingface.co/spaces/<your-username>/social-transcriber
git push space main
```

Git asks for credentials: username is your HF username, **password is an access
token** with write permission from https://huggingface.co/settings/tokens.

### 3. Add the key

**Settings → Variables and secrets → New secret** → `GEMINI_API_KEY`. Then
**Restart** the Space so it picks the value up.

Your app lands at `https://<your-username>-social-transcriber.hf.space`.

### Why the Dockerfile already works there

| Spaces requirement | Handled by |
| --- | --- |
| Listen on `app_port` | `ENV PORT=7860` |
| Run as uid 1000 | `useradd -m -u 1000 user` and `COPY --chown=user:user` |
| Runtime writes go somewhere that user owns | `TMPDIR=/home/user/app/tmp` — Node's `os.tmpdir()` reads `TMPDIR` |

If downloads break months later: **Settings → Factory reboot** rebuilds the
image with a current yt-dlp.

---

# About the Gemini API cost

**The free tier is real and needs no credit card.** Key at
https://aistudio.google.com/apikey. Your exact rate limits are at
https://aistudio.google.com/rate-limit — Google changes them regularly, so read
them there rather than trusting a number from a blog post. Testing a handful of
videos won't come close to the limits.

Two things worth knowing:

- **Free tier content is used to improve Google's products.** Fine for public
  TikToks; think twice about anything private.
- On the paid tier, a 30-second video runs about three or four cents on
  `gemini-3.5-flash`. Video is token-heavy — roughly 300 tokens per second of
  footage.
