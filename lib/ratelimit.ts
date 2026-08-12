/**
 * In-memory rate limiting and daily spend caps.
 *
 * Deliberately not Redis. The app is pinned to a single instance (the web
 * routes share downloaded files on local disk), so a Map is correct here and a
 * network round-trip per request would be pure cost. The trade-off is honest:
 * counters reset on redeploy, and this would silently under-count the moment
 * you run two replicas — at which point the file-sharing assumption breaks
 * first anyway.
 */

import type { NextRequest } from "next/server";

const num = (name: string, fallback: number) =>
  Number(process.env[name] || fallback);

/** Requests allowed per IP per hour on the public web routes. */
export const WEB_PER_HOUR = num("RATE_LIMIT_WEB_PER_HOUR", 20);
/** Requests allowed per API key per hour. */
export const API_PER_HOUR = num("RATE_LIMIT_API_PER_HOUR", 120);
/** Hard ceiling on Gemini calls per day, per surface. Protects the bill. */
export const DAILY_CAP_WEB = num("DAILY_CAP_WEB", 100);
export const DAILY_CAP_API = num("DAILY_CAP_API", 1000);

const HOUR_MS = 60 * 60 * 1000;

// key -> timestamps of recent hits
const hits = new Map<string, number[]>();

/**
 * Best-effort client identity.
 *
 * Behind Railway (or any proxy) the socket address is the proxy's, so
 * x-forwarded-for is the only useful signal. It's spoofable by anyone talking
 * directly to the origin, so treat this as abuse-dampening, not security.
 */
export function clientIp(req: NextRequest): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim();
  return req.headers.get("x-real-ip") || "unknown";
}

export type RateResult = {
  ok: boolean;
  remaining: number;
  retryAfterSeconds: number;
};

/** Sliding-window limiter. */
export function rateLimit(key: string, limit: number, windowMs = HOUR_MS): RateResult {
  const now = Date.now();
  const cutoff = now - windowMs;

  const recent = (hits.get(key) ?? []).filter((t) => t > cutoff);

  if (recent.length >= limit) {
    const oldest = recent[0]!;
    hits.set(key, recent);
    return {
      ok: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((oldest + windowMs - now) / 1000)),
    };
  }

  recent.push(now);
  hits.set(key, recent);

  // Keep the map from growing forever on a long-lived process.
  if (hits.size > 5000) {
    for (const [k, v] of hits) {
      if (v.every((t) => t <= cutoff)) hits.delete(k);
    }
  }

  return { ok: true, remaining: limit - recent.length, retryAfterSeconds: 0 };
}

// --- daily budget -----------------------------------------------------------

let day = "";
const spent = { web: 0, api: 0 };

function today(): string {
  return new Date().toISOString().slice(0, 10); // UTC
}

function rollover() {
  const d = today();
  if (d !== day) {
    day = d;
    spent.web = 0;
    spent.api = 0;
  }
}

export type Surface = "web" | "api";

/**
 * Count one Gemini call against the day's budget.
 *
 * Called *before* the work starts, so a burst can't slip past while requests
 * are in flight.
 */
export function consumeDailyBudget(surface: Surface): {
  ok: boolean;
  used: number;
  cap: number;
} {
  rollover();
  const cap = surface === "web" ? DAILY_CAP_WEB : DAILY_CAP_API;

  if (spent[surface] >= cap) {
    return { ok: false, used: spent[surface], cap };
  }
  spent[surface] += 1;
  return { ok: true, used: spent[surface], cap };
}

/** Give a slot back when the work failed before reaching Gemini. */
export function refundDailyBudget(surface: Surface): void {
  rollover();
  if (spent[surface] > 0) spent[surface] -= 1;
}

export function budgetStatus() {
  rollover();
  return {
    web: { used: spent.web, cap: DAILY_CAP_WEB },
    api: { used: spent.api, cap: DAILY_CAP_API },
  };
}
