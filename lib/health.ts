/**
 * Shape of GET /api/health.
 *
 * Deliberately free of server imports so client components can use the type
 * without dragging `node:fs` into the browser bundle.
 */

export type HealthResponse = {
  status: "ok" | "degraded";
  checks: {
    geminiApiKey: string;
    ytdlp: string;
  };
  config: {
    model: string;
    modelApi: string;
    geminiKeys: string;
    dailyUsage: {
      web: { used: number; cap: number };
      api: { used: number; cap: number };
    };
    apiAuth: string;
    notionWebhook: string;
    downloadAttempts: number;
  };
};

/** What the badge shows. "offline" means the request itself failed. */
export type HealthState = "loading" | "ok" | "degraded" | "offline";
