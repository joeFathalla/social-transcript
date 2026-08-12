/**
 * Pulls a Reel / TikTok / Facebook video down to a local file.
 *
 * We invoke the yt-dlp binary directly rather than depending on an npm wrapper.
 * The popular wrapper (`yt-dlp-exec`) has a postinstall step that requires a
 * `python` binary on PATH, which breaks `npm ci` in any clean Node image — and
 * it pins an older yt-dlp than pip or brew will give you. yt-dlp is the one
 * dependency worth keeping current, since platform changes break it first.
 *
 * Downloads fail intermittently — these platforms throttle, time out, and
 * occasionally return empty responses to requests that would succeed a second
 * later. So `download()` retries. It does NOT retry failures that are settled
 * facts (deleted post, private account, unsupported URL); five attempts at a
 * post that doesn't exist is just fifteen wasted seconds.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { AttemptInfo, SourceInfo } from "./analysis";

const run = promisify(execFile);

export const MAX_DURATION_S = Number(process.env.MAX_DURATION_S || 600);
export const MAX_FILESIZE_MB = Number(process.env.MAX_FILESIZE_MB || 200);
const COMPRESS_ABOVE_MB = Number(process.env.COMPRESS_ABOVE_MB || 45);

/** How many times to try the download in total, first attempt included. */
export const MAX_ATTEMPTS = Math.max(1, Number(process.env.DOWNLOAD_ATTEMPTS || 5));
/** Base backoff. Waits go 1s, 2s, 3s, 4s — long enough to matter, short
 *  enough that five attempts still finish inside ten seconds of waiting. */
const RETRY_BASE_MS = Number(process.env.RETRY_BASE_MS || 1000);
const RETRY_MAX_MS = Number(process.env.RETRY_MAX_MS || 4000);

const USER_AGENT =
  process.env.YTDLP_USER_AGENT ||
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/**
 * Hosts we accept, mapped to a display name.
 *
 * Kept as an explicit allowlist rather than "anything yt-dlp supports": this
 * endpoint is public, and yt-dlp speaks to well over a thousand sites — most
 * of which nobody should be able to pull through your server.
 */
const ALLOWED_HOSTS = new Map<string, string>([
  ["instagram.com", "Instagram"],
  ["www.instagram.com", "Instagram"],
  ["instagr.am", "Instagram"],

  ["tiktok.com", "TikTok"],
  ["www.tiktok.com", "TikTok"],
  ["m.tiktok.com", "TikTok"],
  ["vm.tiktok.com", "TikTok"],
  ["vt.tiktok.com", "TikTok"],

  // Reels, /watch, /<page>/videos/<id>, /share/v/<id>, and fb.watch shortlinks.
  ["facebook.com", "Facebook"],
  ["www.facebook.com", "Facebook"],
  ["m.facebook.com", "Facebook"],
  ["web.facebook.com", "Facebook"],
  ["mbasic.facebook.com", "Facebook"],
  ["fb.watch", "Facebook"],
  ["www.fb.watch", "Facebook"],
]);

/** Where to claim we came from. Wrong referers get requests refused. */
const REFERER: Record<string, string> = {
  Instagram: "https://www.instagram.com/",
  TikTok: "https://www.tiktok.com/",
  Facebook: "https://www.facebook.com/",
};

/** An error whose message is safe (and useful) to show the user. */
export class DownloadError extends Error {
  hint?: string;
  /** Whether trying again in a second or two could plausibly succeed. */
  retryable: boolean;
  /**
   * Whether this message is worth showing the user verbatim.
   *
   * "That post is private" tells them something they can act on. "HTTP Error
   * 503" or "unable to extract player response" tells them nothing and reads
   * like the app is broken — those get replaced with a generic message and
   * survive only in the server logs.
   */
  userFacing: boolean;

  constructor(
    message: string,
    hint?: string,
    retryable = false,
    userFacing = true
  ) {
    super(message);
    this.name = "DownloadError";
    this.hint = hint;
    this.retryable = retryable;
    this.userFacing = userFacing;
  }
}

/** The single message shown for any failure to obtain the video. */
export const GENERIC_DOWNLOAD_ERROR =
  "Could not get the video. Please try again later.";

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
  const platform = ALLOWED_HOSTS.get(host);
  if (!platform) {
    throw new DownloadError(
      "Only Instagram, TikTok and Facebook links are supported.",
      "Paste a Reel, a TikTok video, or a Facebook video link."
    );
  }

  // Strip tracking junk; keeps the URL stable and avoids odd extractor paths.
  parsed.hash = "";
  for (const key of [...parsed.searchParams.keys()]) {
    // fbclid rides along on every shared Facebook link and is pure tracking.
    if (
      key.startsWith("utm_") ||
      key === "igsh" ||
      key === "igshid" ||
      key === "fbclid" ||
      key === "mibextid" ||
      key === "rdid"
    ) {
      parsed.searchParams.delete(key);
    }
  }

  return { url: parsed.toString(), platform };
}

/**
 * Where the yt-dlp binary lives.
 *
 * The Docker image pip-installs it and points YTDLP_PATH at it. Locally it's
 * whatever `brew install yt-dlp` put on your PATH.
 */
function binaryPath(): string {
  return process.env.YTDLP_PATH || "yt-dlp";
}

/**
 * Turn yt-dlp's stderr into something a human can act on, and decide whether
 * trying again is worth the wait.
 */
function classify(stderr: string, fallback: string): DownloadError {
  const s = (stderr || fallback).toLowerCase();

  // ---- Transport-level, checked FIRST -------------------------------------
  // Order matters. "HTTP Error 503: Service Unavailable" contains the word
  // "unavailable", which the deleted-post rule below would otherwise claim —
  // turning a retryable blip into a permanent failure.

  if (s.includes("enoent") || s.includes("no such file or directory")) {
    return new DownloadError(
      "yt-dlp isn't installed on this server.",
      "Install it (`brew install yt-dlp` locally; the Docker image does it " +
        "via pip) or point YTDLP_PATH at an existing copy.",
      false,
      false
    );
  }
  if (
    /http error 5\d\d/.test(s) ||
    s.includes("service unavailable") ||
    s.includes("bad gateway") ||
    s.includes("gateway time-out") ||
    s.includes("gateway timeout") ||
    s.includes("internal server error")
  ) {
    return new DownloadError(
      "The platform returned a server error.",
      "Their end, not yours.",
      true,
      false
    );
  }
  if (
    s.includes("timed out") ||
    s.includes("timeout") ||
    s.includes("etimedout") ||
    s.includes("econnreset") ||
    s.includes("econnrefused") ||
    s.includes("eai_again") ||
    s.includes("temporary failure in name resolution") ||
    s.includes("connection reset") ||
    s.includes("connection aborted") ||
    s.includes("incomplete read")
  ) {
    return new DownloadError(
      "The connection dropped or timed out.",
      undefined,
      true,
      false
    );
  }
  if (
    s.includes("rate-limit") ||
    s.includes("rate limit") ||
    s.includes("too many requests") ||
    s.includes("http error 429")
  ) {
    return new DownloadError(
      "Rate-limited by the platform.",
      "Backing off and trying again.",
      true,
      false
    );
  }

  // ---- Permanent: the answer will be the same in two seconds ---------------

  if (s.includes("private") || s.includes("only available to")) {
    return new DownloadError(
      "That post is private.",
      "Private posts can't be downloaded without an account that follows them."
    );
  }
  // Deliberately specific. A bare `includes("unavailable")` also swallows
  // "503 Service Unavailable", and a bare `includes("not found")` swallows
  // shell "command not found".
  if (
    s.includes("video unavailable") ||
    s.includes("post is unavailable") ||
    s.includes("content is unavailable") ||
    s.includes("is not available") ||
    s.includes("isn't available") ||
    s.includes("no longer available") ||
    s.includes("has been removed") ||
    s.includes("been deleted") ||
    s.includes("does not exist") ||
    s.includes("http error 404") ||
    s.includes("404: not found")
  ) {
    return new DownloadError("That post doesn't exist or has been deleted.");
  }
  if (s.includes("unsupported url")) {
    return new DownloadError(
      "yt-dlp doesn't recognise that URL.",
      "Use the direct link to the post."
    );
  }
  if (s.includes("file is larger than max-filesize")) {
    return new DownloadError(`That video is larger than ${MAX_FILESIZE_MB} MB.`);
  }
  if (s.includes("age") && s.includes("restrict")) {
    return new DownloadError(
      "That post is age-restricted.",
      "Sign-in cookies are required. Set COOKIES_FILE."
    );
  }
  // ---- Transient: worth another go ----------------------------------------

  if (
    s.includes("login required") ||
    s.includes("empty media response") ||
    s.includes("cannot parse data") ||
    s.includes("no video formats found")
  ) {
    return new DownloadError(
      "The platform refused to serve that video.",
      "Usually a rate limit or an IP block. If it keeps happening, set " +
        "COOKIES_FILE to a cookies.txt from a logged-in account, or route " +
        "yt-dlp through a residential proxy with YTDLP_PROXY.",
      true,
      false
    );
  }
  if (s.includes("ip address is blocked") || s.includes("blocked from accessing")) {
    return new DownloadError(
      "The platform blocked this server's IP for that post.",
      "Often intermittent. If it persists, a residential proxy (YTDLP_PROXY) " +
        "is the reliable fix — datacenter IPs get blocked aggressively.",
      true,
      false
    );
  }
  if (s.includes("unable to extract") || s.includes("unable to download webpage")) {
    return new DownloadError(
      "Couldn't read the post page.",
      "Often transient. If it persists after a few attempts, yt-dlp may need " +
        "updating — the platform has probably changed something.",
      true,
      false
    );
  }

  // Unknown: assume transient. A retry costs a second; a false "permanent"
  // costs the user a video they could have had.
  const firstLine = (stderr || fallback)
    .split("\n")
    .find((l) => l.includes("ERROR"));
  return new DownloadError(
    "Couldn't download that video.",
    (firstLine || fallback).slice(0, 300),
    true,
    false
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wipe half-written files so a retry starts from a clean directory. */
function clearPartials(workdir: string) {
  try {
    for (const entry of fs.readdirSync(workdir)) {
      if (entry.startsWith("source.")) {
        fs.rmSync(path.join(workdir, entry), { force: true });
      }
    }
  } catch {
    /* best effort */
  }
}

function ytdlpArgs(url: string, platform: string, outTemplate: string): string[] {
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
    // yt-dlp does its own low-level retries within a single run; ours sit on
    // top and re-run the whole extraction, which recovers from more.
    "--retries", "2",
    "--socket-timeout", "30",
    "--max-filesize", `${MAX_FILESIZE_MB}M`,
    "--user-agent", USER_AGENT,
    "--referer", REFERER[platform] || "https://www.google.com/",
  ];

  const cookies = process.env.COOKIES_FILE || path.join(process.cwd(), "cookies.txt");
  if (fs.existsSync(/* turbopackIgnore: true */ cookies)) {
    args.push("--cookies", cookies);
  }
  if (process.env.YTDLP_PROXY) args.push("--proxy", process.env.YTDLP_PROXY);

  return args;
}

/** One download attempt. Throws a classified DownloadError on failure. */
async function attemptDownload(
  url: string,
  platform: string,
  workdir: string
): Promise<{ videoPath: string; source: SourceInfo }> {
  const outTemplate = path.join(workdir, "source.%(ext)s");

  try {
    await run(binaryPath(), ytdlpArgs(url, platform, outTemplate), {
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (err: unknown) {
    const e = err as { stderr?: string; message?: string; killed?: boolean };
    if (e.killed) {
      throw new DownloadError(
        "The download took too long and was stopped.",
        undefined,
        true,
        false
      );
    }
    throw classify(e.stderr || "", e.message || "Unknown download failure");
  }

  const entries = fs
    .readdirSync(workdir)
    .filter(
      (f) =>
        f.startsWith("source.") &&
        !f.endsWith(".info.json") &&
        !f.endsWith(".part")
    )
    .map((f) => path.join(workdir, f))
    .filter((f) => fs.statSync(f).isFile() && fs.statSync(f).size > 0);

  if (entries.length === 0) {
    // yt-dlp exited 0 but produced nothing. Seen when a platform returns an
    // empty media response — often transient.
    throw new DownloadError(
      "The download finished but produced no video.",
      "The post may be private, deleted, or region-locked.",
      true,
      false
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
    // Permanent — the video isn't going to get shorter.
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
 * Download with retries.
 *
 * `onAttempt` is called before every attempt and again when one fails, so the
 * UI can show which try it's on and why the last one didn't work.
 */
export async function download(
  url: string,
  platform: string,
  workdir: string,
  onAttempt: (info: AttemptInfo) => void = () => {}
): Promise<{ videoPath: string; source: SourceInfo; attempts: number }> {
  let lastError: DownloadError | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    onAttempt({ phase: "trying", attempt, maxAttempts: MAX_ATTEMPTS });

    try {
      const result = await attemptDownload(url, platform, workdir);
      return { ...result, attempts: attempt };
    } catch (err: unknown) {
      lastError =
        err instanceof DownloadError
          ? err
          : new DownloadError(
              "Couldn't download that video.",
              err instanceof Error ? err.message.slice(0, 300) : undefined,
              true,
              false
            );

      // Settled facts don't improve with repetition.
      if (!lastError.retryable) break;
      if (attempt === MAX_ATTEMPTS) break;

      const delay = Math.min(RETRY_BASE_MS * attempt, RETRY_MAX_MS);
      onAttempt({
        phase: "failed",
        attempt,
        maxAttempts: MAX_ATTEMPTS,
        error: lastError.message,
        hint: lastError.hint,
        retryInMs: delay,
      });

      clearPartials(workdir);
      await sleep(delay);
    }
  }

  throw lastError ?? new DownloadError("Couldn't download that video.");
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
