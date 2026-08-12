/**
 * Step 2: send an already-downloaded clip to Gemini.
 *
 * Streams NDJSON progress events so the UI can show what's happening during
 * the 30-90s the model takes, instead of a spinner that looks frozen.
 */

import { NextRequest, NextResponse } from "next/server";

import type { StreamEvent } from "@/lib/analysis";
import { GeminiError, analyzeVideo } from "@/lib/gemini";
import {
  DAILY_CAP_WEB,
  WEB_PER_HOUR,
  clientIp,
  consumeDailyBudget,
  rateLimit,
  refundDailyBudget,
} from "@/lib/ratelimit";
import { clipPath, getMeta, saveAnalysis } from "@/lib/store";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  // This is the endpoint that actually spends money, and it has no API key in
  // front of it, so both limits apply here.
  const limit = rateLimit(`web:${clientIp(req)}`, WEB_PER_HOUR);
  if (!limit.ok) {
    return NextResponse.json(
      {
        error: "Too many requests. Please try again later.",
        hint: `Limit is ${WEB_PER_HOUR} per hour.`,
      },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } }
    );
  }

  const budget = consumeDailyBudget("web");
  if (!budget.ok) {
    return NextResponse.json(
      {
        error: "The daily limit for this site has been reached.",
        hint: `Cap is ${DAILY_CAP_WEB} videos per day. It resets at midnight UTC.`,
      },
      { status: 429 }
    );
  }

  const body = await req.json().catch(() => ({}));
  const id = String(body?.id ?? "");

  let meta;
  try {
    meta = getMeta(id);
  } catch {
    meta = null;
  }

  if (!meta) {
    // Never reached Gemini, so don't charge the day for it.
    refundDailyBudget("web");
    return NextResponse.json(
      {
        error: "That clip has expired or was never downloaded.",
        hint: "Fetch the video again.",
      },
      { status: 404 }
    );
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: StreamEvent) => {
        controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      };

      try {
        send({ stage: "uploading", message: "Uploading video to Gemini", pct: 20 });

        const result = await analyzeVideo(
          clipPath(meta),
          meta.mimeType,
          (message) => {
            const pct = message.includes("processing")
              ? 45
              : message.includes("Watching")
                ? 65
                : 30;
            send({ stage: "analyzing", message, pct });
          },
          "web"
        );

        // Cached so /api/send-to-notion can forward it without trusting the
        // browser to send the analysis back.
        saveAnalysis(meta.id, result);

        send({ stage: "done", result, source: meta.source });
      } catch (err: unknown) {
        if (err instanceof GeminiError) {
          send({ stage: "error", error: err.message, hint: err.hint });
        } else {
          console.error("[analyze]", err);
          send({
            stage: "error",
            error: "Analysis failed.",
            hint: err instanceof Error ? err.message.slice(0, 300) : undefined,
          });
        }
      } finally {
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
