# Deploying to Render (free)

Start to finish, about 15 minutes — most of it waiting for the first build.

---

## Do I need a GitHub repo?

**Yes.** Render builds your Dockerfile from a Git repo; there's no "upload a
folder" option. (The only alternative is building the image yourself and
pushing it to a registry for Render to pull, which is more work, not less.)

Your project already has a git repo with one commit and no remote, so it's just
a matter of pushing it.

---

## 1. Push to GitHub

Everything below runs in Terminal, on your Mac, from the project folder.

First, check that nothing secret is about to be committed:

```bash
cd ~/Documents/Joe/projects/social-transcriber
git status --short
git check-ignore -v .env.local     # should print a line — meaning it IS ignored
```

`.env.local` holds your API key and must stay out of the repo. If
`git check-ignore` prints nothing, stop and fix `.gitignore` before continuing.

Then commit:

```bash
git add -A
git commit -m "Two-step fetch/analyze pipeline, Gemini video analysis, Docker deploy"
```

Create the repo and push. With the GitHub CLI:

```bash
gh repo create social-transcriber --private --source=. --push
```

Without it, create an empty repo at https://github.com/new (no README, no
.gitignore), then:

```bash
git remote add origin https://github.com/<your-username>/social-transcriber.git
git branch -M main
git push -u origin main
```

---

## 2. Deploy on Render

1. Sign up at https://render.com with your GitHub account. No credit card for
   the free plan.
2. **New → Blueprint**, pick the `social-transcriber` repo.
3. Render reads `render.yaml` and configures everything itself. It will prompt
   for one value: **`GEMINI_API_KEY`**. Paste the key from your `.env.local`.
4. **Apply**. The first build takes 5-10 minutes — it's installing ffmpeg and
   yt-dlp into the image. Later builds are much faster thanks to layer caching.

If the Blueprint flow gives you trouble, the manual path works identically:
**New → Web Service** → connect the repo → Render detects the Dockerfile →
choose **Free** instance → add `GEMINI_API_KEY` under Environment.

You'll get a URL like `https://social-transcriber-xxxx.onrender.com`.

---

## 3. What to expect on the free plan

| | |
| --- | --- |
| **Cold starts** | The service sleeps after 15 minutes idle. The next request takes ~1 minute to wake it. This is normal; don't debug it |
| **RAM** | 512 MB. Fine for this app — `render.yaml` already caps clip size to match |
| **Hours** | 750 instance-hours/month across your whole account |
| **Disk** | Ephemeral. Downloaded clips vanish on redeploy, which is exactly what we want |

---

## 4. Testing it

Open your Render URL and try a **TikTok** link first. TikTok is more forgiving
of cloud IPs than Instagram is.

If the page loads and the video plays, the hard part works. Then hit **Analyze
with Gemini**.

To check the backend without the UI:

```bash
curl -sS -X POST https://<your-app>.onrender.com/api/fetch \
  -H 'content-type: application/json' \
  -d '{"url":"https://www.tiktok.com/@user/video/1234567890"}' | jq
```

A successful response has an `id` and a `mediaUrl`.

---

## 5. When something fails

Render's **Logs** tab is the first place to look — the app logs the real error
behind every message the UI shows you.

| What you see | What it means | Fix |
| --- | --- | --- |
| `Instagram refused to serve that video` | Instagram is blocking Render's IP, or the post is private | Upload cookies (below), or accept that Instagram needs a residential IP |
| `TikTok blocked this server's IP` | Same problem, TikTok's version | Try a different Render region, or a proxy |
| `GEMINI_API_KEY is not set` | The env var didn't get saved | Render dashboard → Environment → add it → redeploy |
| `The model "…" isn't available on your key` | Your key doesn't have that model | Add `GEMINI_MODEL` with a model you do have |
| Build fails on `npm ci` | `package-lock.json` out of sync with `package.json` | Run `npm install` locally, commit the lockfile, push |
| First request hangs ~60s | Cold start | Not a bug |

### Adding Instagram cookies

If Instagram blocks you and you want to push through:

1. In a browser logged into Instagram (**use a throwaway account** — automated
   use can get an account restricted), export cookies in Netscape format with a
   `cookies.txt` browser extension.
2. Render dashboard → your service → **Environment** → **Secret Files** →
   add a file named `cookies.txt`, paste the contents. Render mounts secret
   files at `/etc/secrets/`.
3. Add an env var `COOKIES_FILE` = `/etc/secrets/cookies.txt`.
4. Redeploy.

Cookies expire. When Instagram starts failing again months later, this is why.

---

## About the Gemini API cost

**The free tier is real and you don't need a credit card.** Get a key at
https://aistudio.google.com/apikey. Your exact rate limits (requests per minute
and per day) are at https://aistudio.google.com/rate-limit — Google changes
them regularly, so check there rather than trusting a number from a blog post.

For testing a handful of videos you will not come close to the limits.

Two things to know:

- **Free tier content is used to improve Google's products.** Fine for testing
  public TikToks; think twice about anything private.
- If you do move to the paid tier, a 30-second video costs roughly three or
  four cents to analyse on `gemini-3.5-flash`. Video is token-heavy — around
  300 tokens per second of footage.
