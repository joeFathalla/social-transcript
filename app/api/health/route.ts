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
import { apiKeyFor, modelFor } from "@/lib/gemini";
import { budgetStatus } from "@/lib/ratelimit";

const run = promisify(execFile);

export const runtime = "nodejs";

// The badge in the UI polls this, so the check runs often. Spawning yt-dlp on
// every poll — from every open tab — is needless work for an answer that
// changes only on redeploy.
let cached: { at: number; version: string | null } | null = null;
const CACHE_MS = 60_000;

async function ytdlpVersion(): Promise<string | null> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.version;

  let version: string | null = null;
  try {
    const { stdout } = await run(process.env.YTDLP_PATH || "yt-dlp", ["--version"], {
      timeout: 10_000,
    });
    version = stdout.trim() || null;
  } catch {
    version = null;
  }

  cached = { at: Date.now(), version };
  return version;
}

export async function GET() {
  const ytdlp = await ytdlpVersion();

  const webKey = Boolean(apiKeyFor("web"));
  const apiKey = Boolean(apiKeyFor("api"));

  const checks = {
    // Either surface having a key means the app can do something; both
    // missing means it can do nothing at all.
    geminiKey: webKey || apiKey,
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
        // Say *what was tried*. "MISSING" alone sends people hunting; naming
        // the path turns it into an obvious fix.
        ytdlp: ytdlp
          ? `ok (${ytdlp})`
          : `MISSING — tried "${process.env.YTDLP_PATH || "yt-dlp"}"`,
      },
      config: {
        model: modelFor("web"),
        modelApi: modelFor("api"),
        geminiKeys: `web: ${webKey ? "set" : "MISSING"}, api: ${apiKey ? "set" : "MISSING"}`,
        dailyUsage: budgetStatus(),
        apiAuth: authRequired() ? "enabled" : "OPEN — anyone can call /api/transcribe",
        notionWebhook: process.env.N8N_WEBHOOK_URL ? "configured" : "not configured",
        downloadAttempts: MAX_ATTEMPTS,
      },
    },
    { status: healthy ? 200 : 503 }
  );
}
