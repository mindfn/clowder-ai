'use client';

import { useCallback, useEffect, useState } from 'react';
import { MarkdownContent } from './MarkdownContent';

const TERMINAL_ACTIONS = new Set<DesktopUpdatePromptAction>(['download', 'later', 'skip']);

export function DesktopUpdatePrompt() {
  const [prompt, setPrompt] = useState<DesktopUpdatePromptPayload | null>(null);

  useEffect(() => {
    const bridge = window.desktopBridge;
    if (!bridge) return;
    const unsubscribe = bridge.onUpdatePrompt((nextPrompt) => setPrompt(nextPrompt));
    bridge.updatePromptReady();
    return unsubscribe;
  }, []);

  const sendAction = useCallback(
    (action: DesktopUpdatePromptAction) => {
      if (!prompt || !window.desktopBridge) return;
      window.desktopBridge.sendUpdatePromptAction(action, prompt.version);
      if (TERMINAL_ACTIONS.has(action)) setPrompt(null);
    },
    [prompt],
  );

  useEffect(() => {
    if (!prompt) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') sendAction('later');
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [prompt, sendAction]);

  if (!prompt) return null;

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-[var(--console-overlay-backdrop)] p-4 backdrop-blur-sm">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="desktop-update-title"
        className="flex max-h-[82vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-cafe bg-cafe-surface shadow-2xl"
      >
        <header className="border-b border-cafe px-6 py-5">
          <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-semantic-info">Update Available</p>
          <h2 id="desktop-update-title" className="text-xl font-semibold text-cafe-primary">
            Clowder AI{' '}
            <a
              data-testid="desktop-update-release-link"
              href={prompt.releaseUrl}
              onClick={(event) => {
                event.preventDefault();
                sendAction('open-release');
              }}
              className="text-semantic-info underline decoration-transparent underline-offset-4 transition-colors hover:decoration-current"
            >
              v{prompt.version}
            </a>{' '}
            is available
          </h2>
          <p className="mt-2 text-sm text-cafe-secondary">Current version: v{prompt.currentVersion}</p>
        </header>

        <div data-testid="desktop-update-notes" className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          {prompt.releaseNotes ? (
            <MarkdownContent content={prompt.releaseNotes} disableCommandPrefix />
          ) : (
            <p className="text-sm text-cafe-secondary">Open the release page to see the complete release notes.</p>
          )}
        </div>

        <footer className="flex flex-wrap justify-end gap-2 border-t border-cafe bg-cafe-surface-elevated px-6 py-4">
          <button
            type="button"
            onClick={() => sendAction('skip')}
            className="rounded-lg px-4 py-2 text-sm text-cafe-secondary transition-colors hover:bg-cafe-surface-sunken"
          >
            Skip This Version
          </button>
          <button
            type="button"
            onClick={() => sendAction('later')}
            className="rounded-lg px-4 py-2 text-sm text-cafe-secondary transition-colors hover:bg-cafe-surface-sunken"
          >
            Later
          </button>
          <button
            type="button"
            onClick={() => sendAction('download')}
            className="rounded-lg bg-semantic-info px-5 py-2 text-sm font-medium text-[var(--cafe-surface)] transition-opacity hover:opacity-90"
          >
            Download
          </button>
        </footer>
      </section>
    </div>
  );
}
