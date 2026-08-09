/**
 * Hands a finished analysis to an n8n webhook, which is what actually writes
 * to Notion.
 *
 * The app deliberately knows nothing about Notion. It posts a stable JSON
 * payload to whatever URL is in N8N_WEBHOOK_URL, and the workflow on the other
 * side decides what to do with it. That keeps Notion credentials, database ids
 * and field mapping in n8n where they belong, and means the destination can
 * change without redeploying this app.
 *
 * The webhook URL never reaches the browser: the request is proxied through
 * here so it stays a server-side secret.
 */

import { NextRequest, NextResponse } from "next/server";

import { toPlainText } from "@/lib/format";
import { getAnalysis, getMeta } from "@/lib/store";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const webhook = process.env.N8N_WEBHOOK_URL;
  if (!webhook) {
    return NextResponse.json(
      {
        error: "Sending to Notion isn't configured.",
        hint: "Set N8N_WEBHOOK_URL to your n8n webhook and restart.",
      },
      { status: 501 }
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
    return NextResponse.json(
      { error: "That clip has expired.", hint: "Fetch and analyse it again." },
      { status: 404 }
    );
  }

  const analysis = getAnalysis(id);
  if (!analysis) {
    return NextResponse.json(
      { error: "This video hasn't been analysed yet." },
      { status: 409 }
    );
  }

  const payload = {
    clipId: id,
    sentAt: new Date().toISOString(),
    source: meta.source,
    analysis,
    // Same pre-joined text /api/transcribe returns, so both directions hand
    // the workflow an identical shape.
    text: toPlainText(analysis),
  };

  try {
    // n8n workflows that write to Notion and wait for the page can take a
    // while; 60s is generous but bounded so a hung webhook can't wedge us.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45_000);

    const res = await fetch(webhook, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Optional shared secret so the workflow can reject anything that
        // didn't come from this app.
        ...(process.env.N8N_WEBHOOK_SECRET
          ? { "X-Webhook-Secret": process.env.N8N_WEBHOOK_SECRET }
          : {}),
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));

    const text = await res.text();

    if (!res.ok) {
      console.error("[send-to-notion] webhook returned", res.status, text.slice(0, 500));
      return NextResponse.json(
        {
          error: "The automation rejected it.",
          hint: `Webhook responded ${res.status}.`,
        },
        { status: 502 }
      );
    }

    // If the workflow returns JSON with a Notion URL, pass it through so the
    // UI can link straight to the created page.
    let notionUrl: string | undefined;
    try {
      const parsed = JSON.parse(text);
      notionUrl =
        parsed?.notionUrl || parsed?.url || parsed?.page?.url || undefined;
    } catch {
      /* a plain "ok" body is fine too */
    }

    return NextResponse.json({ ok: true, notionUrl });
  } catch (err: unknown) {
    const aborted = err instanceof Error && err.name === "AbortError";
    console.error("[send-to-notion]", err);
    return NextResponse.json(
      {
        error: aborted
          ? "The automation took too long to respond."
          : "Couldn't reach the automation.",
        hint: "Check N8N_WEBHOOK_URL and that the workflow is active.",
      },
      { status: 502 }
    );
  }
}
