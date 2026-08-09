'use client';

import { useState } from 'react';

import ApiDocsModal from './ApiDocsModal';
import HealthBadge from './HealthBadge';

/** Title, live service status, and the API details modal. */
export default function SiteHeader({ subtitle }: { subtitle: string }) {
  const [showDocs, setShowDocs] = useState(false);

  return (
    <>
      <header className="mb-8 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight text-neutral-900 dark:text-neutral-50">
            Social Transcriber
          </h1>
          <p className="mt-2 max-w-xl text-neutral-500 dark:text-neutral-400">{subtitle}</p>
        </div>

        <div className="flex items-center gap-3">
          <HealthBadge />
          <button
            onClick={() => setShowDocs(true)}
            className="rounded-full bg-neutral-900 px-4 py-1.5 text-sm font-medium text-white transition hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-white"
          >
            API Details
          </button>
        </div>
      </header>

      {showDocs && <ApiDocsModal onClose={() => setShowDocs(false)} />}
    </>
  );
}
