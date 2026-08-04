/**
 * Streams a downloaded clip back to the browser.
 *
 * Range support matters here: without it the <video> element can play but not
 * seek, and Safari refuses to play at all.
 */

import fs from "node:fs";
import { Readable } from "node:stream";

import type { NextRequest } from "next/server";

import { clipPath, getMeta } from "@/lib/store";

export const runtime = "nodejs";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const meta = getMeta(id);
  if (!meta) {
    return new Response("Clip not found or expired", { status: 404 });
  }

  const file = clipPath(meta);
  const size = fs.statSync(file).size;
  const range = req.headers.get("range");

  const baseHeaders: Record<string, string> = {
    "Content-Type": meta.mimeType,
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=600",
  };

  if (!range) {
    const stream = Readable.toWeb(
      fs.createReadStream(file)
    ) as unknown as ReadableStream;
    return new Response(stream, {
      status: 200,
      headers: { ...baseHeaders, "Content-Length": String(size) },
    });
  }

  const match = /bytes=(\d*)-(\d*)/.exec(range);
  const start = match?.[1] ? Number(match[1]) : 0;
  const end = match?.[2] ? Number(match[2]) : size - 1;

  if (Number.isNaN(start) || Number.isNaN(end) || start >= size || start > end) {
    return new Response("Range Not Satisfiable", {
      status: 416,
      headers: { "Content-Range": `bytes */${size}` },
    });
  }

  const safeEnd = Math.min(end, size - 1);
  const stream = Readable.toWeb(
    fs.createReadStream(file, { start, end: safeEnd })
  ) as unknown as ReadableStream;

  return new Response(stream, {
    status: 206,
    headers: {
      ...baseHeaders,
      "Content-Range": `bytes ${start}-${safeEnd}/${size}`,
      "Content-Length": String(safeEnd - start + 1),
    },
  });
}
