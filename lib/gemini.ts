/**
 * Upload a local video to Gemini and get back a structured analysis of both
 * its visuals and its audio.
 */

import fs from "node:fs";

import { GoogleGenAI } from "@google/genai";

import {
  ANALYSIS_SCHEMA,
  SYSTEM_INSTRUCTION,
  USER_PROMPT,
  type VideoAnalysis,
} from "./analysis";

/**
 * Which surface a request came from.
 *
 * The two are kept on separate Gemini keys so that web traffic can't exhaust
 * the quota the automation depends on, and so a leaked key only burns one of
 * them. They can also run different models — see MODEL below.
 */
export type Surface = "web" | "api";

function pick(...names: string[]): string {
  for (const n of names) {
    const v = process.env[n];
    if (v) return v;
  }
  return "";
}

/** The key for a surface, falling back to the single shared key. */
export function apiKeyFor(surface: Surface): string {
  return surface === "api"
    ? pick("GEMINI_API_KEY_API", "GEMINI_API_KEY", "GOOGLE_API_KEY")
    : pick("GEMINI_API_KEY_WEB", "GEMINI_API_KEY", "GOOGLE_API_KEY");
}

/**
 * The model for a surface.
 *
 * This — not the billing tier — is where "better results for the API" actually
 * comes from. A paid key does not produce better output than a free one; the
 * same model returns the same quality. Pointing the API surface at a stronger
 * model does.
 */
export function modelFor(surface: Surface): string {
  return surface === "api"
    ? pick("GEMINI_MODEL_API", "GEMINI_MODEL") || "gemini-3.5-flash"
    : pick("GEMINI_MODEL_WEB", "GEMINI_MODEL") || "gemini-3.5-flash";
}

/** Kept for the health endpoint's summary line. */
export const MODEL = modelFor("web");

export class GeminiError extends Error {
  hint?: string;
  constructor(message: string, hint?: string) {
    super(message);
    this.name = "GeminiError";
    this.hint = hint;
  }
}

export function getClient(surface: Surface = "web"): GoogleGenAI {
  const apiKey = apiKeyFor(surface);
  if (!apiKey) {
    throw new GeminiError(
      "No Gemini API key is configured for this surface.",
      "Set GEMINI_API_KEY (or GEMINI_API_KEY_WEB / GEMINI_API_KEY_API). " +
        "Get a key at https://aistudio.google.com/apikey."
    );
  }
  return new GoogleGenAI({ apiKey });
}

type Progress = (message: string) => void;

export async function analyzeVideo(
  videoPath: string,
  mimeType: string,
  onProgress: Progress = () => {},
  surface: Surface = "web"
): Promise<VideoAnalysis> {
  const ai = getClient(surface);
  const model = modelFor(surface);
  let uploadedName: string | null = null;

  try {
    if (!fs.existsSync(videoPath) || fs.statSync(videoPath).size === 0) {
      throw new GeminiError("The downloaded video file is missing or empty.");
    }

    onProgress("Uploading video to Gemini");
    const uploaded = await ai.files.upload({
      file: videoPath,
      config: { mimeType },
    });
    uploadedName = uploaded.name ?? null;

    // Gemini decodes and indexes frames before the file can be referenced.
    onProgress("Gemini is processing the video");
    let file = uploaded;
    const deadline = Date.now() + 5 * 60_000;
    while (file.state === "PROCESSING") {
      if (Date.now() > deadline) {
        throw new GeminiError("Gemini took too long to process this video.");
      }
      await new Promise((r) => setTimeout(r, 2500));
      file = await ai.files.get({ name: uploaded.name! });
    }
    if (file.state === "FAILED") {
      throw new GeminiError(
        "Gemini could not decode this video.",
        file.error?.message || "The file may be corrupt or an unsupported codec."
      );
    }

    onProgress("Watching and listening to the video");
    const interaction = await ai.interactions.create({
      model,
      system_instruction: SYSTEM_INSTRUCTION,
      input: [
        { type: "video", uri: file.uri!, mime_type: file.mimeType! },
        { type: "text", text: USER_PROMPT },
      ],
      response_format: {
        type: "text",
        mime_type: "application/json",
        schema: ANALYSIS_SCHEMA as unknown as Record<string, unknown>,
      },
    });

    const text = interaction.output_text;
    if (!text) {
      throw new GeminiError(
        "Gemini returned an empty response.",
        "This usually means the response was blocked by a safety filter."
      );
    }

    return parseAnalysis(text);
  } catch (err: unknown) {
    throw normalize(err);
  } finally {
    // Uploaded files expire on their own after 48h, but there's no reason to
    // leave them sitting in the project's storage quota.
    if (uploadedName) {
      try {
        await ai.files.delete({ name: uploadedName });
      } catch {
        /* best effort */
      }
    }
  }
}

function parseAnalysis(text: string): VideoAnalysis {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    // Belt and braces: strip a markdown fence if one somehow slipped through.
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) {
      throw new GeminiError("Gemini's response wasn't valid JSON.");
    }
    raw = JSON.parse(match[0]);
  }

  const obj = raw as Partial<VideoAnalysis>;
  const type = obj.content_type;

  return {
    title: obj.title || "Untitled",
    language: obj.language || "Unknown",
    has_speech: Boolean(obj.has_speech),
    content_type:
      type === "ai_skill" || type === "tech_guide" ? type : "other",
    brief: obj.brief || "",
    document: obj.document || "",
    steps: Array.isArray(obj.steps) ? obj.steps : [],
    requirements: Array.isArray(obj.requirements) ? obj.requirements : [],
    key_details: Array.isArray(obj.key_details) ? obj.key_details : [],
    gaps: Array.isArray(obj.gaps) ? obj.gaps : [],
    transcript: Array.isArray(obj.transcript) ? obj.transcript : [],
    scenes: Array.isArray(obj.scenes) ? obj.scenes : [],
    on_screen_text: Array.isArray(obj.on_screen_text) ? obj.on_screen_text : [],
    audio_notes: obj.audio_notes || "",
    hashtags: Array.isArray(obj.hashtags) ? obj.hashtags : [],
  };
}

function normalize(err: unknown): GeminiError {
  if (err instanceof GeminiError) return err;

  const message = err instanceof Error ? err.message : String(err);
  const low = message.toLowerCase();

  if (low.includes("api key") || low.includes("api_key_invalid") || low.includes("401")) {
    return new GeminiError(
      "Gemini rejected your API key.",
      "Check GEMINI_API_KEY in .env.local and restart the dev server."
    );
  }
  if (low.includes("quota") || low.includes("429") || low.includes("resource_exhausted")) {
    return new GeminiError(
      "You've hit your Gemini rate limit or quota.",
      "Wait a moment, or enable billing on your Google AI Studio project."
    );
  }
  if (low.includes("not found") && low.includes("model")) {
    return new GeminiError(
      "That Gemini model isn't available on your key.",
      "Set GEMINI_MODEL in .env.local to a model you have access to."
    );
  }
  if (low.includes("safety") || low.includes("blocked")) {
    return new GeminiError(
      "Gemini blocked this video's analysis on safety grounds."
    );
  }
  return new GeminiError("Gemini request failed.", message.slice(0, 300));
}
