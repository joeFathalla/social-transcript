/**
 * Pulls a Reel / TikTok down to a local file.
 *
 * We shell out to the yt-dlp binary directly rather than going through the
 * `yt-dlp-exec` wrapper's typed flag list, because we need flags the wrapper's
 * types do not cover and we want control over timeouts and stderr.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { SourceInfo } from "./analysis";

const run = promisify(execFile);

export const MAX_DURATION_S = Number(process.env.MAX_DURATION_S || 600);
export const MAX_FILESIZE_MB = Number(process.env.MAX_FILESIZE_MB || 200);
const COMPRESS_ABOVE_MB = Number(process.env.COMPRESS_ABOVE_MB || 45);

const USER_AGENT =
  process.env.YTDLP_USER_AGENT ||
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const ALLOWED_HOSTS = new Set([
  "instagram.com",
  "www.instagram.com",
  "instagr.am",
  "tiktok.com",
  "www.tiktok.com",
  "m.tiktok.com",
  "vm.tiktok.com",
  "vt.tiktok.com",
]);

/** An error whose message is safe (and useful) to show the user. */
export class DownloadError extends Error {
  hint?: string;
  constructor(message: string, hint?: string) {
    super(message);
    this.name = "DownloadError";
    this.hint = hint;
  }
}

export function validateUrl(raw: string): { url: string; platform: string } {
  let value = (raw || "").trim();
  if (!value) throw new DownloadError("Paste a link first.");
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new DownloadError("That doesn't look like a valid URL.");
  }

  const host = parsed.hostname.toLowerCase();
  if (!ALLOWED_HOSTS.has(host)) {
    throw new DownloadError(
      "Only Instagram and TikTok links are supported.",
      "Paste a Reel link (instagram.com/reel/...) or a TikTok video link."
    );
  }

  // Strip tracking junk; keeps the URL stable and avoids odd extractor paths.
  parsed.hash = "";
  for (const key of [...parsed.searchParams.keys()]) {
    if (key.startsWith("utm_") || key === "igsh" || key === "igshid") {
      parsed.searchParams.delete(key);
    }
  }

  return {
    url: parsed.toString(),
    platform: host.includes("tiktok") ? "TikTok" : "Instagram",
  };
}

/**
 * Where the yt-dlp binary lives. `yt-dlp-exec` downloads it into its own
 * package folder at install time; YTDLP_PATH overrides that (useful in Docker
 * where you may prefer a pip-installed yt-dlp that is easier to keep current).
 */
function binaryPath(): string {
  if (process.env.YTDLP_PATH) return process.env.YTDLP_PATH;
  const bundled = path.join(
    process.cwd(),
    "node_modules",
    "yt-dlp-exec",
    "bin",
    process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp"
  );
  // turbopackIgnore keeps the bundler from tracing the whole project into the
  // server output just because these paths are computed at runtime.
  return fs.existsSync(/* turbopackIgnore: true */ bundled) ? bundled : "yt-dlp";
}

function friendlyError(stderr: string, fallback: string): DownloadError {
  const s = (stderr || fallback).toLowerCase();

  if (s.includes("login required") || s.includes("empty media response")) {
    return new DownloadError(
      "Instagram refused to serve that video.",
      "The post is private, or Instagram is blocking this server's IP. " +
        "Export a cookies.txt from a logged-in browser and set COOKIES_FILE, " +
        "or route yt-dlp through a residential proxy with YTDLP_PROXY."
    );
  }
  if (s.includes("ip address is blocked") || s.includes("blocked from accessing")) {
    return new DownloadError(
      "TikTok blocked this server's IP for that post.",
      "A residential proxy (set YTDLP_PROXY) is usually the fix. Cloud and " +
        "datacenter IPs get blocked aggressively."
    );
  }
  if (s.includes("rate-limit") || s.includes("429")) {
    return new DownloadError(
      "You're being rate-limited.",
      "Wait a minute and try again, or use a proxy."
    );
  }
  if (s.includes("private") || s.includes("only available to")) {
    return new DownloadError("That post is private.");
  }
  if (s.includes("unavailable") || s.includes("not found") || s.includes(" 404")) {
    return new DownloadError("That post doesn't exist or has been deleted.");
  }
  if (s.includes("age") && s.includes("restrict")) {
    return new DownloadError(
      "That post is age-restricted.",
      "Sign-in cookies are required. Set COOKIES_FILE."
    );
  }
  if (s.includes("file is larger than max-filesize")) {
    return new DownloadError(`That video is larger than ${MAX_FILESIZE_MB} MB.`);
  }
  if (s.includes("enoent")) {
    return new DownloadError(
      "yt-dlp isn't installed on this server.",
      "Run `npm install` so yt-dlp-exec fetches the binary, or install yt-dlp " +
        "and point YTDLP_PATH at it."
    );
  }

  const firstLine = (stderr || fallback).split("\n").find((l) => l.includes("ERROR"));
  return new DownloadError(
    "Couldn't download that video.",
    (firstLine || fallback).slice(0, 300)
  );
}

export function makeWorkdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "reel-"));
}

export function cleanup(dir: string | null) {
  if (!dir) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

export async function download(
  url: string,
  platform: string,
  workdir: string
): Promise<{ videoPath: string; source: SourceInfo }> {
  const outTemplate = path.join(workdir, "source.%(ext)s");

  const args = [
    url,
    "-o", outTemplate,
    // Prefer a single already-muxed mp4 so ffmpeg merging is never required.
    "-f", "b[ext=mp4]/bv*+ba/b",
    "--merge-output-format", "mp4",
    "--no-playlist",
    "--no-warnings",
    "--no-progress",
    "--no-check-certificates",
    "--write-info-json",
    "--retries", "3",
    "--socket-timeout", "30",
    "--max-filesize", `${MAX_FILESIZE_MB}M`,
    "--user-agent", USER_AGENT,
    "--referer", platform === "TikTok"
      ? "https://www.tiktok.com/"
      : "https://www.instagram.com/",
  ];

  const cookies = process.env.COOKIES_FILE || path.join(process.cwd(), "cookies.txt");
  if (fs.existsSync(/* turbopackIgnore: true */ cookies)) {
    args.push("--cookies", cookies);
  }
  if (process.env.YTDLP_PROXY) args.push("--proxy", process.env.YTDLP_PROXY);

  try {
    await run(binaryPath(), args, {
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (err: unknown) {
    const e = err as { stderr?: string; message?: string };
    throw friendlyError(e.stderr || "", e.message || "Unknown download failure");
  }

  const entries = fs
    .readdirSync(workdir)
    .filter((f) => f.startsWith("source.") && !f.endsWith(".info.json"))
    .map((f) => path.join(workdir, f))
    .filter((f) => fs.statSync(f).isFile() && fs.statSync(f).size > 0);

  if (entries.length === 0) {
    throw new DownloadError(
      "Nothing was downloaded.",
      "The post may be private, deleted, or region-locked."
    );
  }

  const videoPath = entries.sort(
    (a, b) => fs.statSync(b).size - fs.statSync(a).size
  )[0];

  // Metadata is nice-to-have; never fail the request over it.
  let info: Record<string, unknown> = {};
  const infoPath = path.join(workdir, "source.info.json");
  if (fs.existsSync(infoPath)) {
    try {
      info = JSON.parse(fs.readFileSync(infoPath, "utf8"));
    } catch {
      /* ignore */
    }
  }

  const duration = Number(info.duration || 0);
  if (duration && duration > MAX_DURATION_S) {
    throw new DownloadError(
      `That video is ${Math.round(duration)}s long; the limit is ${MAX_DURATION_S}s.`,
      "Raise MAX_DURATION_S if you want to allow longer videos."
    );
  }

  return {
    videoPath,
    source: {
      platform,
      title: String(info.title || info.description || "").slice(0, 200),
      uploader: String(info.uploader || info.channel || info.uploader_id || ""),
      duration,
      thumbnail: String(info.thumbnail || ""),
      webpageUrl: String(info.webpage_url || url),
    },
  };
}

/**
 * Gemini samples video at roughly one frame per second, so a 4K 60fps clip
 * buys us nothing but upload time. Re-encode anything oversized down to 720p.
 */
export async function shrinkIfNeeded(videoPath: string): Promise<string> {
  const sizeMb = fs.statSync(videoPath).size / (1024 * 1024);
  if (sizeMb <= COMPRESS_ABOVE_MB) return videoPath;

  const out = path.join(path.dirname(videoPath), "compressed.mp4");
  try {
    await run(
      process.env.FFMPEG_PATH || "ffmpeg",
      [
        "-y", "-i", videoPath,
        "-vf", "scale='min(1280,iw)':-2,fps=24",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "30",
        "-c:a", "aac", "-b:a", "96k",
        "-movflags", "+faststart",
        out,
      ],
      { timeout: 300_000, maxBuffer: 16 * 1024 * 1024 }
    );
  } catch {
    return videoPath; // compression is best-effort
  }

  return fs.existsSync(out) && fs.statSync(out).size > 0 ? out : videoPath;
}
