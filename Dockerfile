# ---------------------------------------------------------------------------
# Social Transcriber
#
# Built for Railway, but portable to anything that runs a container.
#
# Two things make it portable:
#   * the app binds whatever $PORT the host injects (7860 if nothing is set)
#   * it runs as uid 1000, which some hosts require and none object to
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
 && rm -rf /var/lib/apt/lists/* \
 # pip's script directory varies by base image and Python version. Pin a known
 # path so YTDLP_PATH below can't be wrong, then run it once so a bad install
 # fails the build here rather than showing up as a degraded service later.
 #
 # The guard matters: pip usually lands on /usr/local/bin already, and `ln -sf`
 # errors out when source and destination are the same file.
 && if [ "$(command -v yt-dlp)" != /usr/local/bin/yt-dlp ]; then \
      ln -sf "$(command -v yt-dlp)" /usr/local/bin/yt-dlp; \
    fi \
 && /usr/local/bin/yt-dlp --version

# The official node images already ship a `node` user at uid 1000. Reuse it —
# creating another user at that uid fails with "UID 1000 is not unique".
ENV HOME=/home/node
WORKDIR /home/node/app

# HOSTNAME must be pinned: Docker sets it to the container id, and Next's
# standalone server would bind to that name instead of all interfaces — the
# container starts fine and nothing can reach it.
#
# PORT is only a fallback; Railway and most hosts inject their own at runtime.
#
# TMPDIR puts downloaded clips somewhere `node` owns. Node's os.tmpdir() reads
# TMPDIR, so no code change is needed.
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=7860 \
    TMPDIR=/home/node/app/tmp \
    YTDLP_PATH=/usr/local/bin/yt-dlp

# Still root here, so the directory is created and handed over cleanly.
RUN mkdir -p /home/node/app/tmp && chown -R node:node /home/node/app

COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public

USER node
EXPOSE 7860

# When Instagram or TikTok change something, a stale yt-dlp is the first thing
# to break. Redeploy to rebuild the image with a current one.
CMD ["node", "server.js"]
