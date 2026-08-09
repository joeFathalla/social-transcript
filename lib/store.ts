/**
 * Filesystem-backed store for downloaded clips.
 *
 * Deliberately not an in-memory Map: dev-mode hot reloads wipe module state,
 * and we need the id issued by /api/fetch to still resolve when /api/analyze
 * and /api/media come looking for it seconds later.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { SourceInfo, VideoAnalysis } from "./analysis";

const ROOT = path.join(os.tmpdir(), "social-transcriber");
const TTL_MS = Number(process.env.CLIP_TTL_MINUTES || 30) * 60_000;
const ID_RE = /^[0-9a-f-]{36}$/i;

export type ClipMeta = {
  id: string;
  createdAt: number;
  url: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  source: SourceInfo;
};

function dirFor(id: string): string {
  if (!ID_RE.test(id)) throw new Error("Invalid clip id");
  return path.join(ROOT, id);
}

export function newClipId(): string {
  return crypto.randomUUID();
}

export function clipDir(id: string): string {
  const dir = dirFor(id);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function saveMeta(meta: ClipMeta): void {
  fs.writeFileSync(
    path.join(dirFor(meta.id), "meta.json"),
    JSON.stringify(meta, null, 2)
  );
}

export function getMeta(id: string): ClipMeta | null {
  try {
    const raw = fs.readFileSync(path.join(dirFor(id), "meta.json"), "utf8");
    const meta = JSON.parse(raw) as ClipMeta;
    return fs.existsSync(clipPath(meta)) ? meta : null;
  } catch {
    return null;
  }
}

export function clipPath(meta: ClipMeta): string {
  return path.join(dirFor(meta.id), meta.filename);
}

/**
 * Cache the analysis next to the clip.
 *
 * This is what lets /api/send-to-notion work from an id alone: the browser
 * doesn't have to post the analysis back, so a forged payload can't be pushed
 * into someone's Notion workspace.
 */
export function saveAnalysis(id: string, analysis: VideoAnalysis): void {
  try {
    fs.writeFileSync(
      path.join(dirFor(id), "analysis.json"),
      JSON.stringify(analysis)
    );
  } catch {
    /* non-fatal — the user still gets their result */
  }
}

export function getAnalysis(id: string): VideoAnalysis | null {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(dirFor(id), "analysis.json"), "utf8")
    ) as VideoAnalysis;
  } catch {
    return null;
  }
}

export function removeClip(id: string): void {
  try {
    fs.rmSync(dirFor(id), { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

/** Delete clips older than the TTL. Cheap enough to run on every fetch. */
export function sweep(): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(ROOT);
  } catch {
    return;
  }

  const cutoff = Date.now() - TTL_MS;
  for (const entry of entries) {
    if (!ID_RE.test(entry)) continue;
    const dir = path.join(ROOT, entry);
    try {
      if (fs.statSync(dir).mtimeMs < cutoff) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    } catch {
      /* ignore */
    }
  }
}
