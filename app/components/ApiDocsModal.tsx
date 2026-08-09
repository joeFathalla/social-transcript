'use client';

import { useEffect, useState } from 'react';

/**
 * Everything you need to call the API from n8n, in one screen.
 *
 * The URL is read from the browser so it's correct for whatever host this is
 * deployed on — no placeholder for anyone to forget to replace.
 */
export default function ApiDocsModal({ onClose }: { onClose: () => void }) {
  const [origin, setOrigin] = useState('');

  useEffect(() => {
    setOrigin(window.location.origin);

    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);

    // Stop the page behind the modal scrolling with it.
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4 backdrop-blur-sm sm:p-8"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="API details"
    >
      <div
        className="w-full max-w-2xl rounded-2xl border border-neutral-200 bg-white shadow-xl dark:border-neutral-800 dark:bg-neutral-950"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-neutral-200 px-6 py-4 dark:border-neutral-800">
          <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-50">
            API details
          </h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg px-2 py-1 text-neutral-500 transition hover:bg-neutral-100 dark:hover:bg-neutral-800"
          >
            ✕
          </button>
        </div>

        <div className="space-y-6 px-6 py-5">
          <Field label="Endpoint">
            <Code>{`POST ${origin}/api/transcribe`}</Code>
          </Field>

          <Field label="Headers">
            <Code>{`Content-Type: application/json
X-API-Key: YOUR_KEY`}</Code>
            <p className="mt-2 text-sm text-neutral-500 dark:text-neutral-400">
              Your key is the <Kbd>API_KEY</Kbd> environment variable on the
              server. It isn&apos;t shown here on purpose — this page is public,
              so printing it would defeat the point of having one.
            </p>
          </Field>

          <Field label="Send">
            <Code>{`{ "url": "https://www.tiktok.com/@user/video/1234567890" }`}</Code>
            <p className="mt-2 text-sm text-neutral-500 dark:text-neutral-400">
              Instagram Reel or TikTok links only.
            </p>
          </Field>

          <Field label="Get back">
            <Code>{`{
  "source": {
    "platform": "TikTok",
    "uploader": "someaccount",
    "duration": 31,
    "webpageUrl": "https://..."
  },
  "result": {
    "title": "Short punchy title",
    "language": "Arabic (Egyptian)",
    "has_speech": true,
    "summary": "One or two sentences.",
    "explanation": "What actually happens, in a few paragraphs.",
    "transcript": [
      { "start": "00:00", "end": "00:04", "speaker": "Speaker 1",
        "text": "original language", "text_en": "English" }
    ],
    "scenes":         [ { "start": "00:00", "end": "00:06", "description": "..." } ],
    "on_screen_text": [ { "time": "00:02", "text": "..." } ],
    "audio_notes": "Background music, sound effects.",
    "hashtags": ["cooking", "cairo"]
  },
  "text": {
    "transcript": "[00:00] Speaker 1: ...",
    "scenes":     "[00:00-00:06] ...",
    "full":       "the whole analysis as one document"
  }
}`}</Code>
            <p className="mt-2 text-sm text-neutral-500 dark:text-neutral-400">
              Use <Kbd>text</Kbd> if you just want strings — it&apos;s the same
              content with the arrays already joined, so you don&apos;t need a
              Code node to flatten them.
            </p>
          </Field>

          <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200">
            <strong>Set your request timeout above 60 seconds.</strong>
            <p className="mt-1 text-sm">
              This downloads a real video and runs a real model call, so it
              normally takes 60–120 seconds. In n8n, set the HTTP Request
              node&apos;s <em>Options → Timeout</em> to <Kbd>180000</Kbd> ms.
              The default is far shorter and will abort a request that was going
              to succeed — and the failure looks like the API is broken rather
              than like a timeout.
            </p>
          </div>

          <Field label="Errors">
            <p className="text-sm text-neutral-600 dark:text-neutral-400">
              Always <Kbd>{'{ "error": "...", "hint": "..." }'}</Kbd>.{' '}
              <Kbd>400</Kbd> bad or private link · <Kbd>401</Kbd> wrong API key ·{' '}
              <Kbd>502</Kbd> Gemini failed.
            </p>
          </Field>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ bits -- */

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="mb-2 text-sm font-medium uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
        {label}
      </h3>
      {children}
    </div>
  );
}

function Code({ children }: { children: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="group relative">
      <pre className="overflow-x-auto rounded-xl border border-neutral-200 bg-neutral-50 p-3 text-sm text-neutral-800 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-200">
        <code className="font-mono">{children}</code>
      </pre>
      <button
        onClick={async () => {
          await navigator.clipboard.writeText(children);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
        className="absolute right-2 top-2 rounded-lg border border-neutral-200 bg-white px-2 py-1 text-xs text-neutral-600 opacity-0 transition group-hover:opacity-100 focus:opacity-100 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300"
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded bg-neutral-200 px-1.5 py-0.5 font-mono text-[0.85em] text-neutral-800 dark:bg-neutral-800 dark:text-neutral-200">
      {children}
    </code>
  );
}
