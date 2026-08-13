'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';

import CopyButton from '@/app/components/CopyButton';
import SiteHeader from '@/app/components/SiteHeader';
import type {
  FetchEvent,
  SourceInfo,
  StreamEvent,
  VideoAnalysis,
} from '@/lib/analysis';

type Clip = {
  id: string;
  mediaUrl: string;
  mimeType: string;
  sizeBytes: number;
  source: SourceInfo;
};

type Phase = 'idle' | 'fetching' | 'ready' | 'analyzing' | 'done';
type Tab = 'guide' | 'transcript' | 'scenes' | 'onscreen';
type Err = { message: string; hint?: string; details?: string } | null;

/** "01:23" -> 83 */
function toSeconds(stamp: string): number {
  const parts = stamp.split(':').map(Number);
  if (parts.some(Number.isNaN)) return 0;
  return parts.reduce((acc, part) => acc * 60 + part, 0);
}

function prettySize(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Yields each JSON object from an NDJSON response body as it arrives. */
async function* ndjson<T>(body: ReadableStream<Uint8Array>): AsyncGenerator<T> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim()) yield JSON.parse(line) as T;
    }
  }
  if (buffer.trim()) yield JSON.parse(buffer) as T;
}

/** Strips markdown syntax so the skill doc reads as plain text. */
function markdownToText(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```[a-z]*\n?/gi, '').replace(/```/g, ''))
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^>\s?/gm, '')
    .replace(/^[-*+]\s+/gm, '• ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .trim();
}

function prettyDuration(seconds: number): string {
  if (!seconds) return '';
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export default function Home() {
  const [url, setUrl] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [clip, setClip] = useState<Clip | null>(null);
  const [analysis, setAnalysis] = useState<VideoAnalysis | null>(null);
  const [progress, setProgress] = useState({ message: '', pct: 0 });
  const [error, setError] = useState<Err>(null);
  // Download progress. yt-dlp's byte counts aren't parsed, so this eases
  // forward on a timer and only reaches 100% when the file actually lands —
  // it shows liveness honestly rather than inventing a percentage.
  const [dlPct, setDlPct] = useState(0);
  const [tab, setTab] = useState<Tab>('guide');
  const [showOriginal, setShowOriginal] = useState(true);
  const [copied, setCopied] = useState(false);
  const [notion, setNotion] = useState<{
    state: 'idle' | 'sending' | 'sent' | 'error';
    url?: string;
    message?: string;
  }>({ state: 'idle' });

  // Whether the server has an N8N_WEBHOOK_URL. Without one the button would
  // only ever produce a "not configured" error, so it isn't shown at all.
  const [notionEnabled, setNotionEnabled] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    // /api/health already reports this, so there's no second endpoint to add
    // and no need to leak the webhook URL itself to the browser.
    fetch('/api/health', { cache: 'no-store' })
      .then((r) => r.json())
      .then((h) => setNotionEnabled(h?.config?.notionWebhook === 'configured'))
      .catch(() => setNotionEnabled(false));
  }, []);

  // Ease toward 92% while downloading. Retries don't reset it — from the
  // user's side it's one download that's taking a while, not five attempts.
  useEffect(() => {
    if (phase !== 'fetching') return;

    setDlPct((p) => (p === 0 ? 8 : p));
    const id = setInterval(() => {
      setDlPct((p) => (p >= 92 ? p : p + Math.max(0.4, (92 - p) * 0.05)));
    }, 180);

    return () => clearInterval(id);
  }, [phase]);

  const busy = phase === 'fetching' || phase === 'analyzing';

  function reset() {
    setClip(null);
    setAnalysis(null);
    setError(null);
    setProgress({ message: '', pct: 0 });
    setDlPct(0);
    setNotion({ state: 'idle' });
    setTab('guide');
  }

  /** Hand the finished analysis to the n8n workflow that writes to Notion. */
  async function sendToNotion() {
    if (!clip) return;
    setNotion({ state: 'sending' });

    try {
      const res = await fetch('/api/send-to-notion', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: clip.id }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        setNotion({
          state: 'error',
          message: data.hint || data.error || 'Failed to send.',
        });
        return;
      }
      setNotion({ state: 'sent', url: data.notionUrl });
    } catch {
      setNotion({ state: 'error', message: 'Could not reach the server.' });
    }
  }

  /** Step 1 — download the clip so it can be previewed. */
  async function handleFetch(e: FormEvent) {
    e.preventDefault();
    reset();
    setPhase('fetching');

    try {
      const res = await fetch('/api/fetch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });

      // A bad URL is rejected before the stream starts, as plain JSON.
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        setError({ message: data.error || 'Failed to fetch video', hint: data.hint });
        setPhase('idle');
        return;
      }

      for await (const event of ndjson<FetchEvent>(res.body)) {
        if (event.stage === 'ready') {
          // Fill the bar, let it land, then reveal the player. Without the
          // pause the bar is replaced mid-animation and never visibly
          // completes — which is the one moment worth showing.
          setDlPct(100);
          await new Promise((r) => setTimeout(r, 450));

          setClip({
            id: event.id,
            mediaUrl: event.mediaUrl,
            mimeType: event.mimeType,
            sizeBytes: event.sizeBytes,
            source: event.source,
          });
          setPhase('ready');
        } else if (event.stage === 'error') {
          setError({
            message: event.error,
            hint: event.hint,
            details: event.details,
          });
          setPhase('idle');
        }
        // 'downloading' and 'retrying' need no UI: retries are the app's
        // problem, not something to make the user watch.
      }
    } catch (err: unknown) {
      setError({
        message: 'Could not get the video. Please try again later.',
        details: err instanceof Error ? err.message : undefined,
      });
      setPhase('idle');
    }
  }

  /** Step 2 — hand the downloaded file to Gemini. */
  async function handleAnalyze() {
    if (!clip) return;
    setError(null);
    setAnalysis(null);
    setPhase('analyzing');
    setProgress({ message: 'Starting', pct: 10 });

    try {
      const res = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: clip.id }),
      });

      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        setError({ message: data.error || 'Analysis failed', hint: data.hint });
        setPhase('ready');
        return;
      }

      for await (const event of ndjson<StreamEvent>(res.body)) {
        if (event.stage === 'done') {
          setAnalysis(event.result);
          setProgress({ message: 'Done', pct: 100 });
          setPhase('done');
        } else if (event.stage === 'error') {
          setError({ message: event.error, hint: event.hint });
          setPhase('ready');
        } else {
          setProgress({ message: event.message, pct: event.pct });
        }
      }
    } catch (err: unknown) {
      setError({
        message: 'Lost connection during analysis.',
        hint: err instanceof Error ? err.message : undefined,
      });
      setPhase('ready');
    }
  }

  function seekTo(stamp: string) {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = toSeconds(stamp);
    void video.play();
  }

  function copyText(): string {
    if (!analysis) return '';
    if (tab === 'guide') return analysis.document;
    return transcriptText();
  }

  function transcriptText(): string {
    if (!analysis) return '';
    return analysis.transcript
      .map(
        (seg) =>
          `[${seg.start}] ${seg.speaker}: ${showOriginal ? seg.text : seg.text_en}`
      )
      .join('\n');
  }

  async function copyTranscript() {
    await navigator.clipboard.writeText(copyText());
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  function downloadJson() {
    if (!analysis) return;
    const blob = new Blob([JSON.stringify({ source: clip?.source, analysis }, null, 2)], {
      type: 'application/json',
    });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `${analysis.title.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.json`;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  const docLabel =
    analysis?.content_type === 'ai_skill'
      ? 'AI Skill'
      : analysis?.content_type === 'tech_guide'
        ? 'Guide'
        : 'Notes';

  const descriptionText = analysis
    ? [
        analysis.brief,
        analysis.requirements.length > 0
          ? `Requirements:\n${analysis.requirements.map((r) => `• ${r}`).join('\n')}`
          : '',
        analysis.key_details.length > 0
          ? `Key details:\n${analysis.key_details.map((k) => `${k.label}: ${k.value}`).join('\n')}`
          : '',
        analysis.gaps.length > 0
          ? `Not covered by the video:\n${analysis.gaps.map((g) => `• ${g}`).join('\n')}`
          : '',
      ]
        .filter(Boolean)
        .join('\n\n')
    : '';

  const stepsText = analysis
    ? analysis.steps
        .map((st) => {
          const cmds = st.commands.length ? `\n${st.commands.join('\n')}` : '';
          return `${st.number}. [${st.timestamp}] ${st.title}\n${st.detail}${cmds}`;
        })
        .join('\n\n')
    : '';

  const skillText = analysis ? markdownToText(analysis.document) : '';

  const tabs: { key: Tab; label: string; count?: number }[] = [
    { key: 'guide', label: docLabel, count: analysis?.steps.length },
    { key: 'transcript', label: 'Transcript', count: analysis?.transcript.length },
    { key: 'scenes', label: 'Scenes', count: analysis?.scenes.length },
    { key: 'onscreen', label: 'On screen', count: analysis?.on_screen_text.length },
  ];

  return (
    <main className="min-h-screen bg-neutral-50 dark:bg-neutral-950 px-4 py-10 sm:px-6">
      <div className="mx-auto w-full max-w-5xl">
        <SiteHeader subtitle="Paste an Instagram, TikTok or Facebook video link. Watch it, then let Gemini read the visuals and the audio." />

        {/* Step 1 — the link */}
        <form onSubmit={handleFetch} className="flex flex-col gap-3 sm:flex-row">
          <input
            type="text"
            inputMode="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="TikTok, Instagram Reel or Facebook video link…"
            required
            disabled={busy}
            className="flex-1 rounded-xl border border-neutral-200 bg-white px-4 py-3 text-neutral-900 outline-none transition focus:border-neutral-900 disabled:opacity-50 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-100 dark:focus:border-neutral-400"
          />
          <button
            type="submit"
            disabled={busy || !url.trim()}
            className="rounded-xl bg-neutral-900 px-6 py-3 font-medium text-white transition hover:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-white"
          >
            {phase === 'fetching' ? 'Fetching…' : 'Get video'}
          </button>
        </form>

        {error && (
          <div className="mt-6 rounded-xl border border-red-200 bg-red-50 p-4 dark:border-red-900/50 dark:bg-red-950/40">
            <p className="font-medium text-red-700 dark:text-red-300">{error.message}</p>
            {error.hint && (
              <p className="mt-1 text-sm text-red-600/80 dark:text-red-400/80">{error.hint}</p>
            )}
            {/* Only populated when SHOW_DOWNLOAD_ERROR_DETAILS is on. */}
            {error.details && (
              <p className="mt-2 font-mono text-xs text-red-600/60 dark:text-red-400/60">
                {error.details}
              </p>
            )}
          </div>
        )}

        {phase === 'fetching' && (
          <div className="mt-6 rounded-xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
            <div className="mb-3 flex items-baseline justify-between gap-4">
              <p className="text-neutral-700 dark:text-neutral-300">
                {dlPct >= 100 ? 'Video downloaded' : 'Downloading the video…'}
              </p>
              <span className="text-sm tabular-nums text-neutral-500 dark:text-neutral-400">
                {Math.round(dlPct)}%
              </span>
            </div>

            <div className="h-2 w-full overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-800">
              <div
                className={`h-full rounded-full transition-all duration-300 ease-out ${
                  dlPct >= 100 ? 'bg-green-500' : 'bg-blue-600'
                }`}
                style={{ width: `${dlPct}%` }}
              />
            </div>
          </div>
        )}

        {/* Step 2 — preview and analyse */}
        {clip && (
          <div className="mt-8 grid gap-8 lg:grid-cols-[320px_1fr]">
            <aside className="space-y-4">
              <video
                ref={videoRef}
                src={clip.mediaUrl}
                controls
                playsInline
                className="w-full rounded-xl border border-neutral-200 bg-black dark:border-neutral-800"
              />

              <dl className="space-y-1.5 text-sm">
                <Row label="Platform" value={clip.source.platform} />
                {clip.source.uploader && <Row label="Author" value={clip.source.uploader} />}
                {clip.source.duration > 0 && (
                  <Row label="Length" value={prettyDuration(clip.source.duration)} />
                )}
                <Row label="Size" value={prettySize(clip.sizeBytes)} />
              </dl>

              <button
                onClick={handleAnalyze}
                disabled={busy}
                className="w-full rounded-xl bg-blue-600 px-4 py-3 font-medium text-white transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {phase === 'analyzing' ? 'Analyzing…' : analysis ? 'Analyze again' : 'Analyze with Gemini'}
              </button>

              {phase === 'analyzing' && (
                <div className="space-y-2">
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-800">
                    <div
                      className="h-full rounded-full bg-blue-600 transition-all duration-500"
                      style={{ width: `${progress.pct}%` }}
                    />
                  </div>
                  <p className="text-sm text-neutral-500 dark:text-neutral-400">
                    {progress.message}…
                  </p>
                </div>
              )}
            </aside>

            <section className="min-w-0">
              {!analysis && phase !== 'analyzing' && (
                <div className="rounded-xl border border-dashed border-neutral-300 p-10 text-center text-neutral-500 dark:border-neutral-800 dark:text-neutral-400">
                  Video downloaded. Play it to check it&apos;s the right one, then
                  hit <span className="font-medium">Analyze with Gemini</span>.
                </div>
              )}

              {analysis && (
                <div className="space-y-5">
                  <div>
                    <h2 className="text-xl font-semibold text-neutral-900 dark:text-neutral-50">
                      {analysis.title}
                    </h2>
                    <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
                      {analysis.language}
                      {!analysis.has_speech && ' · no speech'}
                    </p>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 border-b border-neutral-200 pb-2 dark:border-neutral-800">
                    {tabs.map((t) => (
                      <button
                        key={t.key}
                        onClick={() => setTab(t.key)}
                        className={`rounded-lg px-3 py-1.5 text-sm transition ${
                          tab === t.key
                            ? 'bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900'
                            : 'text-neutral-600 hover:bg-neutral-200 dark:text-neutral-400 dark:hover:bg-neutral-800'
                        }`}
                      >
                        {t.label}
                        {typeof t.count === 'number' && t.count > 0 && (
                          <span className="ml-1.5 opacity-60">{t.count}</span>
                        )}
                      </button>
                    ))}
                    <div className="ml-auto flex gap-2">
                      {notionEnabled && (
                        <button
                          onClick={sendToNotion}
                          disabled={notion.state === 'sending'}
                          className="rounded-lg bg-neutral-900 px-3 py-1.5 text-sm text-white transition hover:bg-neutral-700 disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-white"
                        >
                          {notion.state === 'sending'
                            ? 'Sending…'
                            : notion.state === 'sent'
                              ? 'Sent to Notion ✓'
                              : 'Send to Notion'}
                        </button>
                      )}
                      <button
                        onClick={copyTranscript}
                        className="rounded-lg border border-neutral-200 px-3 py-1.5 text-sm text-neutral-600 transition hover:bg-neutral-100 dark:border-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-800"
                      >
                        {copied ? 'Copied' : tab === 'guide' ? 'Copy document' : 'Copy transcript'}
                      </button>
                      <button
                        onClick={downloadJson}
                        className="rounded-lg border border-neutral-200 px-3 py-1.5 text-sm text-neutral-600 transition hover:bg-neutral-100 dark:border-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-800"
                      >
                        JSON
                      </button>
                    </div>
                  </div>

                  {notion.state === 'error' && (
                    <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">
                      {notion.message}
                    </p>
                  )}
                  {notion.state === 'sent' && notion.url && (
                    <p className="text-sm text-neutral-600 dark:text-neutral-400">
                      Saved —{' '}
                      <a
                        href={notion.url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-blue-600 underline dark:text-blue-400"
                      >
                        open in Notion
                      </a>
                    </p>
                  )}

                  {tab === 'guide' && (
                    <div className="space-y-5">
                      {descriptionText && (
                        <Card title="Description" copyText={descriptionText}>
                          <div className="space-y-4">
                            {analysis.brief && (
                              <pre className="w-full max-w-full whitespace-pre-wrap break-words font-sans text-neutral-800 dark:text-neutral-200">
                                {analysis.brief}
                              </pre>
                            )}

                            {analysis.requirements.length > 0 && (
                              <div>
                                <h4 className="mb-1 text-xs font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
                                  Requirements
                                </h4>
                                <ul className="list-disc space-y-1 pl-5">
                                  {analysis.requirements.map((r, i) => (
                                    <li key={i}>{r}</li>
                                  ))}
                                </ul>
                              </div>
                            )}

                            {analysis.key_details.length > 0 && (
                              <div>
                                <h4 className="mb-1 text-xs font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
                                  Key details
                                </h4>
                                <dl className="space-y-1.5 text-sm">
                                  {analysis.key_details.map((k, i) => (
                                    <div key={i} className="flex gap-3">
                                      <dt className="w-40 shrink-0 text-neutral-500 dark:text-neutral-400">
                                        {k.label}
                                      </dt>
                                      <dd className="break-all font-mono text-neutral-800 dark:text-neutral-200">
                                        {k.value}
                                      </dd>
                                    </div>
                                  ))}
                                </dl>
                              </div>
                            )}

                            {analysis.gaps.length > 0 && (
                              <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-900/60 dark:bg-amber-950/30">
                                <h4 className="mb-1.5 text-xs font-medium uppercase tracking-wide text-amber-800 dark:text-amber-300">
                                  Not covered by the video
                                </h4>
                                <ul className="list-disc space-y-1 pl-5 text-amber-900 dark:text-amber-200">
                                  {analysis.gaps.map((g, i) => (
                                    <li key={i}>{g}</li>
                                  ))}
                                </ul>
                              </div>
                            )}
                          </div>
                        </Card>
                      )}

                      {analysis.steps.length > 0 && (
                        <Card title="Steps" copyText={stepsText}>
                          <div className="space-y-3">
                            {analysis.steps.map((st) => (
                              <div
                                key={st.number}
                                className="rounded-xl border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900"
                              >
                                <div className="flex items-baseline gap-3">
                                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-neutral-900 text-xs font-medium text-white dark:bg-neutral-100 dark:text-neutral-900">
                                    {st.number}
                                  </span>
                                  <h4 className="font-medium text-neutral-900 dark:text-neutral-100">
                                    {st.title}
                                  </h4>
                                  <button
                                    onClick={() => seekTo(st.timestamp)}
                                    className="ml-auto shrink-0 font-mono text-xs text-blue-600 hover:underline dark:text-blue-400"
                                  >
                                    {st.timestamp}
                                  </button>
                                </div>

                                <p className="mt-2 pl-9 text-neutral-700 dark:text-neutral-300">
                                  {st.detail}
                                </p>

                                {st.commands.map((cmd, i) => (
                                  <pre
                                    key={i}
                                    className="mt-2 ml-9 overflow-x-auto rounded-lg bg-neutral-100 p-3 text-sm dark:bg-neutral-800"
                                  >
                                    <code className="font-mono text-neutral-800 dark:text-neutral-200">
                                      {cmd}
                                    </code>
                                  </pre>
                                ))}
                              </div>
                            ))}
                          </div>
                        </Card>
                      )}

                      {analysis.document && (
                        <Card title={docLabel} copyText={skillText}>
                          <pre className="w-full max-w-full whitespace-pre-wrap break-words font-sans text-neutral-800 dark:text-neutral-200">
                            {skillText}
                          </pre>
                        </Card>
                      )}

                      {!analysis.document && analysis.steps.length === 0 && (
                        <Empty>
                          This video doesn&apos;t contain a procedure.
                        </Empty>
                      )}
                    </div>
                  )}

                  {tab === 'transcript' && (
                    <div className="space-y-3">
                      {analysis.transcript.length === 0 ? (
                        <Empty>No speech in this video.</Empty>
                      ) : (
                        <>
                          <label className="flex items-center gap-2 text-sm text-neutral-600 dark:text-neutral-400">
                            <input
                              type="checkbox"
                              checked={showOriginal}
                              onChange={(e) => setShowOriginal(e.target.checked)}
                              className="accent-blue-600"
                            />
                            Show original language
                          </label>
                          <ul className="space-y-2">
                            {analysis.transcript.map((seg, i) => (
                              <li
                                key={i}
                                className="rounded-xl border border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-900"
                              >
                                <div className="flex items-baseline gap-3">
                                  <button
                                    onClick={() => seekTo(seg.start)}
                                    className="shrink-0 font-mono text-xs text-blue-600 hover:underline dark:text-blue-400"
                                  >
                                    {seg.start}
                                  </button>
                                  <span className="shrink-0 text-xs font-medium text-neutral-500 dark:text-neutral-400">
                                    {seg.speaker}
                                  </span>
                                </div>
                                <p className="mt-1.5 text-neutral-800 dark:text-neutral-200">
                                  {showOriginal ? seg.text : seg.text_en}
                                </p>
                                {showOriginal && seg.text_en !== seg.text && (
                                  <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
                                    {seg.text_en}
                                  </p>
                                )}
                              </li>
                            ))}
                          </ul>
                        </>
                      )}
                    </div>
                  )}

                  {tab === 'scenes' && (
                    <ul className="space-y-2">
                      {analysis.scenes.length === 0 && <Empty>No scene breakdown.</Empty>}
                      {analysis.scenes.map((scene, i) => (
                        <li
                          key={i}
                          className="rounded-xl border border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-900"
                        >
                          <button
                            onClick={() => seekTo(scene.start)}
                            className="font-mono text-xs text-blue-600 hover:underline dark:text-blue-400"
                          >
                            {scene.start} – {scene.end}
                          </button>
                          <p className="mt-1.5 text-neutral-800 dark:text-neutral-200">
                            {scene.description}
                          </p>
                        </li>
                      ))}
                    </ul>
                  )}

                  {tab === 'onscreen' && (
                    <ul className="space-y-2">
                      {analysis.on_screen_text.length === 0 && (
                        <Empty>No text appears on screen.</Empty>
                      )}
                      {analysis.on_screen_text.map((item, i) => (
                        <li
                          key={i}
                          className="flex items-baseline gap-3 rounded-xl border border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-900"
                        >
                          <button
                            onClick={() => seekTo(item.time)}
                            className="shrink-0 font-mono text-xs text-blue-600 hover:underline dark:text-blue-400"
                          >
                            {item.time}
                          </button>
                          <p className="text-neutral-800 dark:text-neutral-200">{item.text}</p>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </section>
          </div>
        )}
      </div>
    </main>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-neutral-500 dark:text-neutral-400">{label}</dt>
      <dd className="truncate text-neutral-800 dark:text-neutral-200">{value}</dd>
    </div>
  );
}

function Card({
  title,
  copyText,
  children,
}: {
  title: string;
  copyText?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
          {title}
        </h3>
        {copyText && <CopyButton text={copyText} />}
      </div>
      <div className="leading-relaxed text-neutral-800 dark:text-neutral-200">{children}</div>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-xl border border-dashed border-neutral-300 p-6 text-center text-neutral-500 dark:border-neutral-800 dark:text-neutral-400">
      {children}
    </p>
  );
}
