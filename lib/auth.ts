/**
 * Shared-secret auth for the machine-facing endpoints.
 *
 * The browser endpoints (/api/fetch, /api/media, /api/analyze) stay open —
 * they're what the web UI calls, and the UI has no secret to present.
 * /api/transcribe is different: it's the one a workflow tool calls, it does the
 * whole expensive pipeline in a single request, and once this app is on a
 * public domain an unauthenticated version of it is a free way for a stranger
 * to spend your Gemini quota.
 */

import type { NextRequest } from "next/server";

/** Unset in development; set it in production. */
export function apiKey(): string {
  return process.env.API_KEY || "";
}

export function authRequired(): boolean {
  return apiKey().length > 0;
}

/**
 * Constant-time compare, so the endpoint doesn't leak the key one character at
 * a time to anyone willing to measure response times.
 */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Returns null when the request is allowed, or a reason string when it isn't.
 *
 * Accepts either `X-API-Key: <key>` or `Authorization: Bearer <key>` — n8n's
 * HTTP Request node makes both easy, so support whichever the caller reaches
 * for first.
 */
export function checkApiKey(req: NextRequest): string | null {
  const expected = apiKey();
  if (!expected) return null; // auth disabled

  const header = req.headers.get("x-api-key");
  const bearer = req.headers.get("authorization");
  const presented = header || (bearer?.startsWith("Bearer ") ? bearer.slice(7) : "");

  if (!presented) return "Missing API key.";
  if (!safeEqual(presented, expected)) return "Invalid API key.";
  return null;
}
