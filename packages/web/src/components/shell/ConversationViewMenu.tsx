'use client';

import type { ConversationViewPreference } from '@cat-cafe/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useCatData } from '@/hooks/useCatData';
import { useConversationViewPreference } from '@/hooks/useConversationViewPreference';
import { useActiveExecutionStore } from '@/stores/activeExecutionStore';
import { useSidebarProjectionStore } from '@/stores/sidebarProjectionStore';
import { conversationViewCopy } from './conversation-view.shell-copy';
import { knownCatName, ShellCatAvatar, UNKNOWN_CAT_NAME } from './ShellCatAvatar';
import { ShellGlyph } from './ShellIcons';
import { useShellCopy } from './shell-copy';

const SHOWN_AVATARS = 3;

export function ConversationViewMenu({ threadId }: { threadId: string }) {
  const participants =
    useSidebarProjectionStore((state) => state.rows.find((row) => row.id === threadId)?.participants) ?? [];
  const executionsByKey = useActiveExecutionStore((state) => state.executionsByKey);
  const runningCatIds = useMemo(
    () =>
      new Set(
        Object.values(executionsByKey)
          .filter((execution) => execution.threadId === threadId)
          .map((execution) => execution.catId),
      ),
    [executionsByKey, threadId],
  );
  if (participants.length === 0) return null;
  return <ReadyConversationViewMenu threadId={threadId} participants={participants} runningCatIds={runningCatIds} />;
}

function ReadyConversationViewMenu({
  threadId,
  participants,
  runningCatIds,
}: {
  threadId: string;
  participants: readonly string[];
  runningCatIds: ReadonlySet<string>;
}) {
  const controller = useConversationViewPreference(threadId);
  const { getCatById } = useCatData();
  const t = useShellCopy(conversationViewCopy);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (restoreFocus: boolean) => {
      setOpen(false);
      if (restoreFocus) triggerRef.current?.focus();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      close(true);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  // F254 does not yet expose exact, owner-facing body-read evidence. A stored
  // cat choice therefore remains durable but cannot become the visible mode.
  const visibleView: ConversationViewPreference = { mode: 'group' };
  const busy = controller.loading || controller.saving;
  const select = async (view: ConversationViewPreference) => {
    if (await controller.save(view)) setOpen(false);
  };

  return (
    <div ref={rootRef} className="relative flex-none" data-testid="conversation-view-control">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${t.currentView}：${t.group}`}
        data-testid="conversation-view-menu-toggle"
        onClick={() => setOpen((current) => !current)}
        className="shell-rail-item shell-focusable inline-flex h-8 max-w-[12rem] items-center gap-1.5 rounded-lg px-2 text-xs"
        style={{ color: 'var(--shell-body)' }}
      >
        <span className="hidden flex-none items-center sm:flex" aria-hidden="true">
          {participants.slice(0, SHOWN_AVATARS).map((catId, index) => (
            <span
              key={catId}
              className="relative inline-flex rounded-full"
              style={{ marginLeft: index === 0 ? 0 : -5, boxShadow: '0 0 0 2px var(--shell-work)' }}
            >
              <ShellCatAvatar catId={catId} size={20} />
              {runningCatIds.has(catId) && (
                <span
                  aria-hidden="true"
                  className="absolute bottom-0 right-0 h-1.5 w-1.5 rounded-full bg-conn-green-text ring-1 ring-[var(--shell-work)]"
                />
              )}
            </span>
          ))}
        </span>
        <span className="min-w-0 truncate font-medium" data-conversation-view-current={visibleView.mode}>
          {t.group}
        </span>
        <ShellGlyph name="chevronDown" className="h-3 w-3 flex-none" />
      </button>

      {open && (
        <div
          role="menu"
          aria-label={t.menuLabel}
          data-testid="conversation-view-menu"
          className="fixed left-3 right-3 top-[3.25rem] z-[60] max-h-[calc(100dvh-4rem)] w-auto overflow-y-auto overscroll-contain rounded-xl p-1.5 sm:absolute sm:left-auto sm:right-0 sm:top-9 sm:w-[min(18rem,calc(100vw-1.5rem))]"
          style={{
            background: 'var(--shell-paper)',
            border: '1px solid var(--shell-hairline-strong)',
            boxShadow: '0 4px 10px rgb(20 20 19 / 0.1)',
          }}
        >
          <button
            type="button"
            role="menuitemradio"
            aria-checked={visibleView.mode === 'group'}
            data-conversation-view="group"
            disabled={busy}
            onClick={() => void select({ mode: 'group' })}
            className="shell-nav-row shell-focusable flex min-h-9 w-full items-center gap-2 rounded-lg px-2 text-left text-sm disabled:cursor-wait disabled:opacity-60"
            data-selected="true"
            style={{ background: 'var(--shell-selected)', color: 'var(--shell-ink)' }}
          >
            <span className="flex h-5 w-5 items-center justify-center" style={{ color: 'var(--shell-muted)' }}>
              <ShellGlyph name="users" className="h-4 w-4" />
            </span>
            <span className="min-w-0 flex-1 truncate">{t.group}</span>
            <ShellGlyph name="check" className="h-3.5 w-3.5 flex-none" />
          </button>

          <div className="my-1 h-px" style={{ background: 'var(--shell-hairline)' }} />
          {participants.map((catId) => {
            const name = knownCatName(catId, getCatById) ?? UNKNOWN_CAT_NAME;
            return (
              <button
                key={catId}
                type="button"
                role="menuitemradio"
                aria-checked={false}
                data-conversation-cat={catId}
                disabled
                className="flex min-h-11 w-full cursor-not-allowed items-center gap-2 rounded-lg px-2 text-left opacity-60"
              >
                <ShellCatAvatar catId={catId} size={22} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm" style={{ color: 'var(--shell-body)' }}>
                    {name}
                  </span>
                  <span className="block truncate text-micro" style={{ color: 'var(--shell-muted)' }}>
                    {runningCatIds.has(catId) ? `${t.working} · ${t.readUnavailable}` : t.readUnavailable}
                  </span>
                </span>
                {runningCatIds.has(catId) && (
                  <span aria-hidden="true" className="h-1.5 w-1.5 flex-none rounded-full bg-conn-green-text" />
                )}
              </button>
            );
          })}

          {(controller.loading || controller.error) && (
            <p
              className="px-2 pb-1 pt-1.5 text-micro"
              style={{ color: controller.error === 'save' ? 'var(--conn-red-text)' : 'var(--shell-muted)' }}
              role={controller.error ? 'status' : undefined}
            >
              {controller.loading ? t.loading : controller.error === 'save' ? t.saveFailed : t.loadFailed}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
