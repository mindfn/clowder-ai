'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { invalidateSidebarProjection } from '@/utils/sidebar-thread-snapshot';
import { AppTooltip } from '../AppTooltip';
import { ShellGlyph } from './ShellIcons';
import { useShellCopy } from './shell-copy';
import { threadMetadataCopy } from './thread-metadata.shell-copy';

interface ThreadMetadataSnapshot {
  pinned: boolean;
  backlogItemId: string | null;
}

interface BacklogItemSummary {
  id: string;
  title: string;
  status: string;
}

function parseThreadMetadata(value: unknown, threadId: string): ThreadMetadataSnapshot {
  if (!value || typeof value !== 'object') throw new Error('Invalid thread detail');
  const candidate = value as Record<string, unknown>;
  if (candidate.id !== threadId) throw new Error('Wrong thread detail');
  if (candidate.pinned !== undefined && typeof candidate.pinned !== 'boolean') throw new Error('Invalid pin state');
  if (candidate.backlogItemId !== undefined && typeof candidate.backlogItemId !== 'string') {
    throw new Error('Invalid Feature association');
  }
  return {
    pinned: candidate.pinned === true,
    backlogItemId: typeof candidate.backlogItemId === 'string' ? candidate.backlogItemId : null,
  };
}

function parseBacklogItems(value: unknown): BacklogItemSummary[] {
  if (!value || typeof value !== 'object') throw new Error('Invalid Feature list');
  const raw = (value as { items?: unknown }).items;
  if (!Array.isArray(raw)) throw new Error('Invalid Feature list');
  return raw.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const candidate = item as Record<string, unknown>;
    return typeof candidate.id === 'string' &&
      typeof candidate.title === 'string' &&
      typeof candidate.status === 'string'
      ? [{ id: candidate.id, title: candidate.title, status: candidate.status }]
      : [];
  });
}

export function ThreadMetadataMenu({ threadId }: { threadId: string }) {
  const copy = useShellCopy(threadMetadataCopy);
  const updateThreadPin = useChatStore((state) => state.updateThreadPin);
  const updateThreadBacklogItem = useChatStore((state) => state.updateThreadBacklogItem);
  const [open, setOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<ThreadMetadataSnapshot | null>(null);
  const [items, setItems] = useState<BacklogItemSummary[]>([]);
  const [state, setState] = useState<'idle' | 'loading' | 'saving' | 'load_failed' | 'save_failed'>('idle');
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  const load = useCallback(async () => {
    setState('loading');
    setSnapshot(null);
    setItems([]);
    try {
      const [threadResponse, backlogResponse] = await Promise.all([
        apiFetch(`/api/threads/${encodeURIComponent(threadId)}`),
        apiFetch('/api/backlog/items'),
      ]);
      if (!threadResponse.ok || !backlogResponse.ok) throw new Error('metadata unavailable');
      const nextSnapshot = parseThreadMetadata(await threadResponse.json(), threadId);
      const allItems = parseBacklogItems(await backlogResponse.json());
      setSnapshot(nextSnapshot);
      setItems(
        allItems.filter(
          (item) => item.id === nextSnapshot.backlogItemId || (item.status !== 'done' && item.status !== 'cancelled'),
        ),
      );
      setState('idle');
    } catch {
      setState('load_failed');
    }
  }, [threadId]);

  useEffect(() => {
    if (!open) return;
    void load();
    const close = (restoreFocus: boolean) => {
      setOpen(false);
      if (restoreFocus) trigger.current?.focus();
    };
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) close(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      close(true);
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [load, open]);

  const save = async (patch: { pinned?: boolean; backlogItemId?: string | null }) => {
    if (!snapshot || state === 'saving') return;
    const prior = snapshot;
    setState('saving');
    try {
      const response = await apiFetch(`/api/threads/${encodeURIComponent(threadId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!response.ok) throw new Error('save rejected');
      const next = parseThreadMetadata(await response.json(), threadId);
      setSnapshot(next);
      if (patch.pinned !== undefined) updateThreadPin(threadId, next.pinned);
      if (patch.backlogItemId !== undefined) updateThreadBacklogItem(threadId, next.backlogItemId);
      void invalidateSidebarProjection();
      setState('idle');
    } catch {
      setSnapshot(prior);
      setState('save_failed');
    }
  };

  if (threadId === 'default') return null;
  const busy = state === 'loading' || state === 'saving';

  return (
    <div ref={root} className="relative flex-none" data-testid="thread-metadata-control">
      <AppTooltip label={copy.open} side="bottom" disabled={open}>
        <button
          ref={trigger}
          type="button"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={copy.open}
          onClick={() => setOpen((current) => !current)}
          className="shell-rail-item shell-focusable flex h-8 w-8 items-center justify-center rounded-lg"
          style={{ color: 'var(--shell-muted)' }}
          data-testid="thread-metadata-menu-toggle"
        >
          <ShellGlyph name="more" />
        </button>
      </AppTooltip>
      {open && (
        <div
          role="dialog"
          aria-label={copy.title}
          className="fixed left-3 right-3 top-[3.25rem] z-[60] w-auto rounded-xl p-3 sm:absolute sm:left-auto sm:right-0 sm:top-9 sm:w-[20rem]"
          style={{
            background: 'var(--shell-paper)',
            border: '1px solid var(--shell-hairline-strong)',
            boxShadow: '0 4px 10px rgb(20 20 19 / 0.1)',
          }}
          data-testid="thread-metadata-menu"
        >
          {snapshot && (
            <div className="space-y-3">
              <label className="flex min-h-9 items-center gap-3 text-sm text-[var(--shell-body)]">
                <input
                  type="checkbox"
                  checked={snapshot.pinned}
                  disabled={busy}
                  onChange={(event) => void save({ pinned: event.target.checked })}
                  className="h-4 w-4 accent-[var(--shell-accent)]"
                />
                <span>{snapshot.pinned ? copy.pinned : copy.pin}</span>
              </label>
              <label className="block text-xs text-[var(--shell-muted)]">
                <span className="mb-1.5 block">{copy.feature}</span>
                <select
                  value={snapshot.backlogItemId ?? ''}
                  disabled={busy}
                  onChange={(event) => void save({ backlogItemId: event.target.value || null })}
                  className="shell-focusable w-full rounded-lg border border-[var(--shell-hairline-strong)] bg-[var(--shell-work)] px-2.5 py-2 text-sm text-[var(--shell-body)]"
                  data-testid="thread-feature-select"
                >
                  <option value="">{copy.noFeature}</option>
                  {items.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.title}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}
          {state === 'loading' && <p className="py-3 text-sm text-[var(--shell-muted)]">{copy.loading}</p>}
          {state === 'load_failed' && (
            <div className="flex items-center gap-2 py-2 text-sm text-conn-red-text" role="alert">
              <span>{copy.loadFailed}</span>
              <button
                type="button"
                className="shell-focusable rounded px-1.5 py-1 font-medium"
                onClick={() => void load()}
              >
                {copy.retry}
              </button>
            </div>
          )}
          {state === 'save_failed' && (
            <p className="mt-2 text-xs text-conn-red-text" role="alert">
              {copy.saveFailed}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
