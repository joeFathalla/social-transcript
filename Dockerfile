# ---------------------------------------------------------------------------
# Social Transcriber
#
# Portable across Koyeb, Hugging Face Spaces, Render, Fly, or plain `docker run`.
#
# The two things that make it portable:
#   * the app binds whatever $PORT the host injects (7860 if the host injects
#     nothing — which is what Hugging Face Spaces expects)
#   * it runs as uid 1000, which Spaces requires and nothing else objects to
# ---------------------------------------------------------------------------

# --- deps -------------------------------------------------------------------
FROM node:22-bookworm-slim AS deps
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci


# --- build ------------------------------------------------------------------
FROM node:22-bookworm-slim AS builder
WORKDIR /app

ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=deps /app/node_modules ./node_modules
COPY . .

RUN npm run build


# --- runtime ----------------------------------------------------------------
FROM node:22-bookworm-slim AS runner

# ffmpeg  -> downscaling oversized clips before upload
# python3 -> yt-dlp is a Python application
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ffmpeg python3 python3-pip ca-certificates \
 && pip3 install --no-cache-dir --break-system-packages yt-dlp \
 && apt-get purge -y python3-pip \
 && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

# The official Node image already provides the non-root `node` user (uid 1000),
# which also satisfies Hugging Face Spaces' uid requirement. Reusing it avoids
# trying to create a duplicate uid during builds on Railway.
USER node

ENV HOME=/home/node
WORKDIR /home/node/app

# HOSTNAME must be pinned: Docker sets it to the container id, and Next's
# standalone server would bind to that name instead of all interfaces — the
# container starts fine and nothing can reach it.
#
# PORT is only a fallback. Koyeb, Render and Cloud Run inject their own PORT at
# runtime, which overrides this. 7860 is what Spaces expects.
#
# TMPDIR moves downloaded clips under a directory `node` owns. Node's
# os.tmpdir() reads TMPDIR, so no code change is needed.
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=7860 \
    TMPDIR=/home/node/app/tmp \
    YTDLP_PATH=/usr/local/bin/yt-dlp

RUN mkdir -p /home/node/app/tmp

COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public

EXPOSE 7860

# When Instagram or TikTok change something, a stale yt-dlp is the first thing
# to break. Redeploy to rebuild the image with a current one.
CMD ["node", "server.js"]
