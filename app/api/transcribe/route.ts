/**
 * One-shot endpoint: link in, full analysis out.
 *
 * The UI uses /api/fetch then /api/analyze so you can preview the clip before
 * spending a model call. This route is the convenience wrapper for scripts and
 * integrations that just want to POST a URL and get JSON back.
 *
 *   curl -X POST localhost:3000/api/transcribe \
 *     -H 'content-type: application/json' \
 *     -d '{"url":"https://www.tiktok.com/@user/video/123"}'
 */

import path from "node:path";

import { NextRequest, NextResponse } from "next/server";

import { checkApiKey } from "@/lib/auth";
import {
  DownloadError,
  download,
  shrinkIfNeeded,
  validateUrl,
} from "@/lib/downloader";
import { toPlainText } from "@/lib/format";
import { GeminiError, analyzeVideo } from "@/lib/gemini";
import { clipDir, newClipId, removeClip, sweep } from "@/lib/store";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const denied = checkApiKey(req);
  if (denied) {
    return NextResponse.json(
      { error: denied, hint: "Send it as X-API-Key or Authorization: Bearer." },
      { status: 401 }
    );
  }

  let id: string | null = null;

  try {
    sweep();

    const body = await req.json().catch(() => ({}));
    const { url, platform } = validateUrl(body?.url ?? "");

    id = newClipId();
    const dir = clipDir(id);

    const { videoPath, source, attempts } = await download(url, platform, dir);
    const finalPath = await shrinkIfNeeded(videoPath);

    const ext = path.extname(finalPath).toLowerCase();
    const mimeType = ext === ".webm" ? "video/webm" : "video/mp4";

    const result = await analyzeVideo(finalPath, mimeType);

    return NextResponse.json({
      source,
      result,
      // Pre-joined text, so a workflow doesn't need a Code node just to turn
      // the arrays into something it can put in a Notion block or a message.
      text: toPlainText(result),
      downloadAttempts: attempts,
    });
  } catch (err: unknown) {
    if (err instanceof DownloadError || err instanceof GeminiError) {
      return NextResponse.json(
        { error: err.message, hint: err.hint },
        { status: err instanceof DownloadError ? 400 : 502 }
      );
    }
    console.error("[transcribe]", err);
    return NextResponse.json(
      { error: "Something went wrong.", hint: err instanceof Error ? err.message : undefined },
      { status: 500 }
    );
  } finally {
    // This route keeps nothing around; the clip was only ever a means to an end.
    if (id) {
      try {
        removeClip(id);
      } catch {
        /* ignore */
      }
    }
  }
}
