/**
 * Health and readiness check.
 *
 * Railway polls this to decide whether a deploy succeeded, and it's the
 * quickest way to tell — from the outside — whether the container came up with
 * everything it needs. It reports what is *configured*, never the values.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { NextResponse } from "next/server";

import { authRequired } from "@/lib/auth";
import { MAX_ATTEMPTS } from "@/lib/downloader";
import { MODEL } from "@/lib/gemini";

const run = promisify(execFile);

export const runtime = "nodejs";

async function ytdlpVersion(): Promise<string | null> {
  try {
    const { stdout } = await run(process.env.YTDLP_PATH || "yt-dlp", ["--version"], {
      timeout: 10_000,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export async function GET() {
  const ytdlp = await ytdlpVersion();

  const checks = {
    geminiKey: Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY),
    ytdlp: Boolean(ytdlp),
  };

  // A missing Gemini key or yt-dlp means the app cannot do its job, so report
  // unhealthy and let the platform surface a failed deploy rather than a
  // service that 500s on first use.
  const healthy = checks.geminiKey && checks.ytdlp;

  return NextResponse.json(
    {
      status: healthy ? "ok" : "degraded",
      checks: {
        geminiApiKey: checks.geminiKey ? "set" : "MISSING",
        ytdlp: ytdlp ? `ok (${ytdlp})` : "MISSING",
      },
      config: {
        model: MODEL,
        apiAuth: authRequired() ? "enabled" : "OPEN — anyone can call /api/transcribe",
        notionWebhook: process.env.N8N_WEBHOOK_URL ? "configured" : "not configured",
        downloadAttempts: MAX_ATTEMPTS,
      },
    },
    { status: healthy ? 200 : 503 }
  );
}
