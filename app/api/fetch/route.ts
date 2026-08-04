/**
 * Step 1: link in, playable video out.
 *
 * Downloads the clip, stores it in a temp folder, and hands back an id the
 * browser can use to stream it from /api/media/[id] and later analyse it via
 * /api/analyze. Nothing is sent to Gemini here.
 */

import fs from "node:fs";
import path from "node:path";

import { NextRequest, NextResponse } from "next/server";

import {
  DownloadError,
  cleanup,
  download,
  shrinkIfNeeded,
  validateUrl,
} from "@/lib/downloader";
import { clipDir, newClipId, saveMeta, sweep } from "@/lib/store";

export const runtime = "nodejs";
export const maxDuration = 180;

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
  let id: string | null = null;

  try {
    sweep();

    const body = await req.json().catch(() => ({}));
    const { url, platform } = validateUrl(body?.url ?? "");

    id = newClipId();
    const dir = clipDir(id);

    const { videoPath, source } = await download(url, platform, dir);

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
      url,
      filename,
      mimeType: MIME_BY_EXT[ext] || "video/mp4",
      sizeBytes: fs.statSync(finalPath).size,
      source,
    };
    saveMeta(meta);

    return NextResponse.json({
      id,
      mediaUrl: `/api/media/${id}`,
      sizeBytes: meta.sizeBytes,
      mimeType: meta.mimeType,
      source,
    });
  } catch (err: unknown) {
    if (id) cleanup(clipDir(id));

    if (err instanceof DownloadError) {
      return NextResponse.json(
        { error: err.message, hint: err.hint },
        { status: 400 }
      );
    }
    console.error("[fetch]", err);
    return NextResponse.json(
      {
        error: "Something went wrong while fetching that video.",
        hint: err instanceof Error ? err.message.slice(0, 300) : undefined,
      },
      { status: 500 }
    );
  }
}
