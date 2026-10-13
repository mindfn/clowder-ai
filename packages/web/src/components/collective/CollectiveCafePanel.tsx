'use client';
import type { CollectiveCafeSection } from '@cat-cafe/shared';
import { useEffect, useRef, useState } from 'react';
import { CollectiveCafeSectionContent } from './CollectiveCafeSectionContent';
import type { CollectiveConnectionProjection } from './collective-client';
import type { useCollectiveParticipation } from './use-collective-participation';
import type { CollectiveWorkPolicyState } from './use-collective-work-policy';

const CAFE_SECTIONS = [
  ['cats', '我的猫'],
  ['channel', '频道'],
  ['calendar', '日程'],
  ['permissions', '授权'],
  ['connection', '连接'],
] as const;

function sectionTitle(section: CollectiveCafeSection, channelId: string) {
  if (section === 'channel') return `# ${channelId}`;
  return (
    {
      cats: '我的猫',
      calendar: '日程',
      permissions: '已允许的工作',
      connection: '连接设置',
    } as const
  )[section];
}

export function CollectiveCafePanel({
  state,
  connection,
  channelId,
  channels,
  busy,
  pairingState,
  onClose,
  onPair,
  onMutate,
  connections,
  onSelectConnection,
  workPolicy,
  initialSection = 'cats',
}: {
  readonly workPolicy?: CollectiveWorkPolicyState;
  readonly initialSection?: CollectiveCafeSection;
  readonly state: ReturnType<typeof useCollectiveParticipation>;
  readonly connection: CollectiveConnectionProjection;
  readonly channelId: string;
  readonly channels: readonly string[];
  readonly busy?: string;
  readonly pairingState: 'waiting' | 'ready' | 'unavailable';
  readonly onClose: () => void;
  readonly onPair: () => void;
  readonly onMutate: (operation: 'reconnect' | 'revoke') => void;
  readonly connections: readonly CollectiveConnectionProjection[];
  readonly onSelectConnection: (id: string) => void;
}) {
  const closeButton = useRef<HTMLButtonElement>(null);
  const [section, setSection] = useState<CollectiveCafeSection>(initialSection);
  useEffect(() => {
    closeButton.current?.focus();
  }, []);
  useEffect(() => {
    setSection(initialSection);
  }, [initialSection]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);
  return (
    <aside
      aria-label="我的猫"
      className="absolute inset-y-0 right-0 z-20 flex w-[min(420px,94%)] flex-col border-l border-[var(--console-border-soft)] bg-[var(--console-card-bg)] text-cafe-primary shadow-[var(--console-elevation-2)]"
    >
      <header className="flex items-center justify-between border-b border-[var(--console-border-soft)] px-5 py-4">
        <div>
          <p className="text-micro text-cafe-muted">我的 Café · 仅自己可见</p>
          <h2 className="mt-1 text-lg font-semibold">{sectionTitle(section, channelId)}</h2>
        </div>
        <button
          ref={closeButton}
          type="button"
          aria-label="关闭我的猫"
          className="px-2 text-2xl text-cafe-muted"
          onClick={onClose}
        >
          ×
        </button>
      </header>
      <nav className="grid grid-cols-5 border-b border-[var(--console-border-soft)] p-2" aria-label="我的猫分区">
        {CAFE_SECTIONS.map(([id, label]) => (
          <button
            key={id}
            type="button"
            aria-pressed={section === id}
            className="rounded-lg px-2 py-2 text-xs text-cafe-secondary aria-pressed:bg-[var(--cafe-surface-sunken)] aria-pressed:text-cafe-primary"
            onClick={() => setSection(id)}
          >
            {label}
          </button>
        ))}
      </nav>
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-5">
        <CollectiveCafeSectionContent
          section={section}
          state={state}
          workPolicy={workPolicy}
          connection={connection}
          connections={connections}
          channelId={channelId}
          channels={channels}
          busy={busy}
          pairingState={pairingState}
          onPair={onPair}
          onMutate={onMutate}
          onSelectConnection={onSelectConnection}
          onSelectCats={() => setSection('cats')}
        />
      </div>
    </aside>
  );
}
