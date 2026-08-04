# ---------------------------------------------------------------------------
# Social Transcriber
#
# Runs anywhere that takes a container: Railway, Render, Fly.io, a plain VPS.
# Deliberately NOT built for Vercel — see README for why.
# ---------------------------------------------------------------------------

# --- deps -------------------------------------------------------------------
FROM node:22-bookworm-slim AS deps
WORKDIR /app

# The image installs a current yt-dlp from pip, so there's no reason to let
# yt-dlp-exec pull its own copy (and hit GitHub's API rate limit) at build time.
ENV YOUTUBE_DL_SKIP_DOWNLOAD=true

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
WORKDIR /app

# HOSTNAME must be pinned: Docker sets it to the container id, and Next's
# standalone server would then try to bind to that name instead of all
# interfaces — the container starts fine and nothing can reach it.
# PORT is a default; hosts like Render override it at runtime.
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    YTDLP_PATH=/usr/local/bin/yt-dlp

# ffmpeg  -> downscaling oversized clips before upload
# python3 -> yt-dlp is a Python application
# ca-certificates -> HTTPS to Instagram/TikTok/Gemini
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ffmpeg python3 python3-pip ca-certificates \
 && pip3 install --no-cache-dir --break-system-packages yt-dlp \
 && apt-get purge -y python3-pip \
 && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

RUN groupadd --system --gid 1001 nodejs \
 && useradd --system --uid 1001 --gid nodejs nextjs

COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

USER nextjs
EXPOSE 3000

# Keeping yt-dlp current matters more than almost anything else here: when
# Instagram or TikTok change their API, a stale yt-dlp is the first thing to
# break. Rebuild the image periodically.
CMD ["node", "server.js"]
