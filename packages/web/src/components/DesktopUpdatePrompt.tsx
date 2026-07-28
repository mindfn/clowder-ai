'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { DesktopUpdateProgressCard } from './DesktopUpdateProgressCard';

const TERMINAL_ACTIONS = new Set<DesktopUpdatePromptAction>(['download', 'later', 'skip']);

export function DesktopUpdatePrompt() {
  const [prompt, setPrompt] = useState<DesktopUpdatePromptPayload | null>(null);
  const [progress, setProgress] = useState<DesktopUpdateProgressPayload | null>(null);
  const [progressHidden, setProgressHidden] = useState(false);
  const progressActive = useRef(false);

  useEffect(() => {
    const bridge = window.desktopBridge;
    if (!bridge) return;
    const unsubscribe = bridge.onUpdatePrompt((nextPrompt) => setPrompt(nextPrompt));
    const unsubscribeProgress = bridge.onUpdateProgress((nextProgress) => {
      const startsTransfer = nextProgress !== null && !progressActive.current;
      progressActive.current = nextProgress !== null;
      setProgress(nextProgress);
      if (startsTransfer || nextProgress === null) setProgressHidden(false);
    });
    bridge.updatePromptReady();
    return () => {
      unsubscribe();
      unsubscribeProgress();
    };
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

  return (
    <>
      {prompt && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center bg-[var(--console-overlay-backdrop)] p-4 backdrop-blur-sm">
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="desktop-update-title"
            className="w-full max-w-lg overflow-hidden rounded-2xl border border-cafe bg-cafe-surface shadow-2xl"
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

            <div className="px-6 py-5">
              <div
                data-testid="desktop-update-recommendation"
                className="rounded-xl border border-semantic-info/30 bg-semantic-info/10 px-4 py-4"
              >
                <p className="text-sm font-semibold text-cafe-primary">
                  Recommended for {prompt.platform === 'windows' ? 'Windows' : 'macOS'}
                </p>
                <code className="mt-2 block break-all text-sm text-semantic-info">{prompt.assetName}</code>
                <p className="mt-2 text-sm text-cafe-secondary">
                  This is the package selected for your current system. The download is verified before installation.
                </p>
              </div>
              <p className="mt-4 text-sm text-cafe-secondary">
                Select the version above to view the complete release notes.
              </p>
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
                {prompt.platform === 'windows' ? 'Download Windows Setup' : 'Download macOS DMG'}
              </button>
            </footer>
          </section>
        </div>
      )}
      {progress && !progressHidden && (
        <DesktopUpdateProgressCard progress={progress} onHide={() => setProgressHidden(true)} />
      )}
    </>
  );
}
