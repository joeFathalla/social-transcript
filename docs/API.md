# API reference

For whoever builds the n8n workflows. Two integration points, one in each
direction.

Base URL is wherever the app is deployed, e.g.
`https://social-transcriber-production.up.railway.app`.

## Is it up?

```bash
curl -s https://YOUR-APP/api/health
```

No auth. Reports whether the Gemini key and yt-dlp are present and whether API
auth is switched on — never the values. `200` when healthy, `503` when
something required is missing.

---

## Direction 1 — n8n asks the app to analyse a video

### `POST /api/transcribe`

Link in, complete analysis out, in a single request. This is the endpoint to
call from an n8n **HTTP Request** node.

**Headers**

```
Content-Type: application/json
X-API-Key: <the API_KEY from the server's .env.production>
```

`Authorization: Bearer <key>` works identically, if that's easier to configure.

**Body**

```json
{ "url": "https://www.instagram.com/reel/XXXXXXXXX/" }
```

Instagram and TikTok video links only.

**Set the n8n node's timeout to at least 180000 ms (3 minutes).** The request
downloads the video, uploads it to Gemini, waits for Gemini to index the
frames, then waits for the analysis. Sixty to ninety seconds is typical; the
node's default timeout is far too short and will abort a request that would
have succeeded.

**Response `200`**

```json
{
  "source": {
    "platform": "Instagram",
    "title": "…",
    "uploader": "someaccount",
    "duration": 31,
    "thumbnail": "https://…",
    "webpageUrl": "https://www.instagram.com/reel/XXXXXXXXX/"
  },
  "result": {
    "title": "Short punchy title",
    "language": "Arabic (Egyptian)",
    "has_speech": true,
    "brief": "**About:** …\n**Tools used:** …\n**You will gain:** …",
    "transcript": [
      {
        "start": "00:00",
        "end": "00:04",
        "speaker": "Speaker 1",
        "text": "original language, verbatim",
        "text_en": "English translation"
      }
    ],
    "scenes": [
      { "start": "00:00", "end": "00:06", "description": "What is on screen." }
    ],
    "on_screen_text": [{ "time": "00:02", "text": "Text burned into the frame" }],
    "audio_notes": "Background music, sound effects, silence.",
    "hashtags": ["cooking", "cairo"]
  },
  "text": {
    "transcript": "[00:00] Speaker 1: original language…",
    "transcriptEnglish": "[00:00] Speaker 1: English…",
    "scenes": "[00:00–00:06] What is on screen.",
    "onScreenText": "[00:02] Text burned into the frame",
    "full": "# Title\n\n**About:** …\n\n## Steps\n…"
  },
  "downloadAttempts": 1
}
```

**Use `text` unless you need the structure.** It's the same content with the
arrays already joined into strings, so a workflow doesn't need a Code node just
to flatten them. `text.full` is the whole analysis as one Markdown-ish
document, ready to drop into a message or a Notion page.

`transcript` is an empty array when nobody speaks — check `has_speech` rather
than assuming there's dialogue.

**Errors**

| Status | Meaning |
| --- | --- |
| `400` | Bad or unsupported URL, private post, deleted post, video too long or too large |
| `401` | Missing or wrong API key |
| `502` | Gemini failed — bad key, quota exhausted, or safety block |
| `500` | Anything else |

All errors are `{ "error": "...", "hint": "..." }`. `hint` is the actionable
part; log it.

---

## Direction 2 — the app pushes a finished analysis to n8n

When someone clicks **Send to Notion** in the web UI, the app POSTs to whatever
URL is in `N8N_WEBHOOK_URL`. Point that at an n8n **Webhook** node.

**What n8n receives**

```json
{
  "clipId": "3f2b…-uuid",
  "sentAt": "2026-08-09T18:20:00.000Z",
  "source": { "platform": "TikTok", "title": "…", "uploader": "…",
              "duration": 24, "thumbnail": "https://…", "webpageUrl": "https://…" },
  "analysis": { /* identical shape to `result` above */ },
  "text":     { /* identical shape to `text` above */ }
}
```

If `N8N_WEBHOOK_SECRET` is set on the server, requests carry
`X-Webhook-Secret: <value>` — have the workflow reject anything without it.

**What to respond**

Anything with a `2xx` status is treated as success. If the response body is
JSON containing `notionUrl` (or `url`, or `page.url`), the app turns it into an
"open in Notion" link for the user — worth returning.

```json
{ "notionUrl": "https://www.notion.so/…" }
```

Respond within 45 seconds or the app reports a timeout. If the Notion write is
slow, respond immediately from the webhook node and do the write afterwards.

---

## The Notion gotcha

**Notion caps a rich text block at 2000 characters.** A transcript is routinely
longer, so it cannot go into a single block or a single property. Two options:

1. **Split it in a Code node** before the Notion node — chunk the joined
   transcript into ≤1900-character pieces and create one paragraph block per
   chunk.
2. **Keep long content out of properties entirely.** Put the short fields
   (title, brief, language, hashtags, source URL) in database properties, and
   the transcript and scene breakdown in the page body as blocks.

A workable database schema:

| Property | Type | Source |
| --- | --- | --- |
| Name | Title | `analysis.title` |
| Source URL | URL | `source.webpageUrl` |
| Platform | Select | `source.platform` |
| Author | Text | `source.uploader` |
| Language | Select | `analysis.language` |
| Duration (s) | Number | `source.duration` |
| Brief | Text | `analysis.brief` (usually under 2000) |
| Tags | Multi-select | `analysis.hashtags` |
| Has speech | Checkbox | `analysis.has_speech` |

Then the page body gets `analysis.brief`, the transcript, and the scene
breakdown as chunked paragraph blocks.

A Code node that does the chunking:

```javascript
const a = $json.analysis;
const chunk = (s, n = 1900) =>
  s.match(new RegExp(`[\\s\\S]{1,${n}}`, 'g')) ?? [];

const transcript = a.transcript
  .map(t => `[${t.start}] ${t.speaker}: ${t.text}`)
  .join('\n');

const scenes = a.scenes
  .map(s => `[${s.start}–${s.end}] ${s.description}`)
  .join('\n');

return [{
  json: {
    ...$json,
    blocks: [
      ...chunk(a.brief),
      ...chunk(transcript),
      ...chunk(scenes),
    ],
  },
}];
```

---

## Other endpoints

These exist for the web UI and aren't meant for automation. They're
unauthenticated because the browser has no secret to present, and they stream
NDJSON rather than returning a single JSON object.

| Route | Purpose |
| --- | --- |
| `GET /api/health` | Deploy check. Safe to call from anywhere |
| `POST /api/fetch` | Downloads a clip, streams retry progress, returns an id |
| `GET /api/media/[id]` | Streams the downloaded video for the preview player |
| `POST /api/analyze` | Analyses a previously fetched clip, streams progress |
| `POST /api/send-to-notion` | Forwards a cached analysis to `N8N_WEBHOOK_URL` |

Use `/api/transcribe` for automation. It does everything those first three do,
in one authenticated call.
