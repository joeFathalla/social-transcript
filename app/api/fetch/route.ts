/**
 * Step 1: link in, playable video out.
 *
 * Streams NDJSON so the browser can show which download attempt we're on and
 * why the last one failed. Downloads from Instagram and TikTok fail often
 * enough that a silent spinner is the wrong UI — the user should be able to
 * see it retrying rather than wonder whether it has hung.
 */

import fs from "node:fs";
import path from "node:path";

import { NextRequest, NextResponse } from "next/server";

import type { FetchEvent } from "@/lib/analysis";
import {
  DownloadError,
  GENERIC_DOWNLOAD_ERROR,
  download,
  shrinkIfNeeded,
  validateUrl,
} from "@/lib/downloader";
import { clipDir, newClipId, removeClip, saveMeta, sweep } from "@/lib/store";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Off by default. Turn on locally when you want the real yt-dlp error in the
 * browser instead of having to read the server log.
 */
const SHOW_DETAILS = process.env.SHOW_DOWNLOAD_ERROR_DETAILS === "true";

const MIME_BY_EXT: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
  ".mpeg": "video/mpeg",
  ".3gp": "video/3gpp",
};

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));

  // URL validation fails fast and doesn't need a stream.
  let target: { url: string; platform: string };
  try {
    target = validateUrl(body?.url ?? "");
  } catch (err: unknown) {
    const e = err as DownloadError;
    return NextResponse.json({ error: e.message, hint: e.hint }, { status: 400 });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const send = (event: FetchEvent) => {
        if (closed) return;
        controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      };

      let id: string | null = null;
      let attempts = 0;

      try {
        sweep();

        id = newClipId();
        const dir = clipDir(id);

        const { videoPath, source, attempts: used } = await download(
          target.url,
          target.platform,
          dir,
          (info) => {
            attempts = info.attempt;

            if (info.phase === "trying") {
              send({
                stage: "downloading",
                message:
                  info.attempt === 1
                    ? "Downloading the video…"
                    : `Downloading the video — attempt ${info.attempt} of ${info.maxAttempts}`,
                attempt: info.attempt,
                maxAttempts: info.maxAttempts,
              });
              return;
            }

            // The real reason goes to the log, not the browser.
            console.warn(
              `[fetch] attempt ${info.attempt}/${info.maxAttempts} failed: ` +
                `${info.error}${info.hint ? ` — ${info.hint}` : ""}`
            );

            send({
              stage: "retrying",
              message: `Couldn't download the video — attempt ${info.attempt} of ${info.maxAttempts}`,
              attempt: info.attempt,
              maxAttempts: info.maxAttempts,
              retryInSeconds: Math.round(info.retryInMs / 100) / 10,
              details: SHOW_DETAILS ? info.error : undefined,
            });
          }
        );
        attempts = used;

        // Downscale oversized clips so the Gemini upload stays quick.
        const finalPath = await shrinkIfNeeded(videoPath);
        if (finalPath !== videoPath) {
          try {
            fs.unlinkSync(videoPath);
          } catch {
            /* ignore */
          }
        }

        const filename = path.basename(finalPath);
        const ext = path.extname(filename).toLowerCase();
        const meta = {
          id,
          createdAt: Date.now(),
          url: target.url,
          filename,
          mimeType: MIME_BY_EXT[ext] || "video/mp4",
          sizeBytes: fs.statSync(finalPath).size,
          source,
        };
        saveMeta(meta);

        send({
          stage: "ready",
          id,
          mediaUrl: `/api/media/${id}`,
          mimeType: meta.mimeType,
          sizeBytes: meta.sizeBytes,
          source,
          attempts,
        });
      } catch (err: unknown) {
        if (id) removeClip(id);

        console.error("[fetch] gave up after", attempts, "attempt(s):", err);

        // One message for every download failure, whatever the cause. The real
        // reason — private post, IP block, timeout — is in the server log.
        send({
          stage: "error",
          error: GENERIC_DOWNLOAD_ERROR,
          attempts,
          details:
            SHOW_DETAILS && err instanceof Error
              ? err.message.slice(0, 300)
              : undefined,
        });
      } finally {
        closed = true;
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
