'use client';

import { useCallback, useEffect, useState } from 'react';

import type { HealthResponse } from '@/lib/health';

const POLL_MS = 60_000;

type State = 'loading' | 'ok' | 'down';

/**
 * Live service status: working, or not.
 *
 * "Degraded" folds into not-OK on purpose — from a caller's point of view a
 * service missing its Gemini key is just as unusable as one that's offline.
 */
export default function HealthBadge() {
  const [state, setState] = useState<State>('loading');

  const check = useCallback(async () => {
    try {
      const res = await fetch('/api/health', { cache: 'no-store' });
      const body = (await res.json()) as HealthResponse;
      setState(res.ok && body.status === 'ok' ? 'ok' : 'down');
    } catch {
      setState('down');
    }
  }, []);

  useEffect(() => {
    check();

    const id = setInterval(() => {
      // No point polling a tab nobody is looking at.
      if (document.visibilityState === 'visible') check();
    }, POLL_MS);

    // Re-check on return, so a stale red dot doesn't linger after recovery.
    const onVisible = () => {
      if (document.visibilityState === 'visible') check();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [check]);

  const dot =
    state === 'ok' ? 'bg-green-500' : state === 'down' ? 'bg-red-500' : 'bg-neutral-400';
  const label =
    state === 'ok' ? 'API OK' : state === 'down' ? 'API not OK' : 'Checking…';

  return (
    <span className="flex items-center gap-2 rounded-full border border-neutral-200 bg-white px-3 py-1.5 text-sm text-neutral-700 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-300">
      <span className="relative flex h-2 w-2">
        {state === 'ok' && (
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-60" />
        )}
        <span className={`relative inline-flex h-2 w-2 rounded-full ${dot}`} />
      </span>
      {label}
    </span>
  );
}
