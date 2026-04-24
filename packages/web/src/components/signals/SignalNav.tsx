import Link from 'next/link';
import React, { useEffect, useMemo, useState } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { getThreadHref } from '../ThreadSidebar/thread-navigation';

export type SignalNavItem = 'chat' | 'signals' | 'sources';

interface SignalNavProps {
  readonly active: SignalNavItem;
}

interface ItemConfig {
  readonly id: SignalNavItem;
  readonly href: string;
  readonly label: string;
}

/**
 * Reads `?from=` URL param to determine the referrer thread.
 * Falls back to store's currentThreadId (last active thread).
 * Same pattern as MissionControlPage referrer-based back button.
 */
function useReferrerThread(): string | null {
  const storeThreadId = useChatStore((s) => s.currentThreadId);
  const [fromParam, setFromParam] = useState<string | null>(null);
  useEffect(() => {
    setFromParam(new URLSearchParams(window.location.search).get('from'));
  }, []);
  return useMemo(() => {
    if (fromParam) return fromParam;
    return storeThreadId && storeThreadId !== 'default' ? storeThreadId : null;
  }, [fromParam, storeThreadId]);
}

export function SignalNav({ active }: SignalNavProps) {
  const referrerThread = useReferrerThread();
  const fromSuffix = referrerThread ? `?from=${encodeURIComponent(referrerThread)}` : '';

  const items: readonly ItemConfig[] = useMemo(
    () => [
      { id: 'signals' as const, href: `/signals${fromSuffix}`, label: 'Signals' },
      { id: 'sources' as const, href: `/signals/sources${fromSuffix}`, label: 'Sources' },
    ],
    [fromSuffix],
  );

  const backHref = getThreadHref(referrerThread ?? 'default');

  return (
    <nav aria-label="Signal navigation" className="flex items-center gap-2">
      <a href={backHref} className="console-button-ghost text-xs" data-testid="signal-back-to-chat">
        <svg
          className="h-4 w-4"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="15 18 9 12 15 6" />
        </svg>
        返回线程
      </a>
      <div className="console-segmented">
        {items.map((item) => {
          const isActive = item.id === active;
          return (
            <Link
              key={item.id}
              href={item.href}
              aria-current={isActive ? 'page' : undefined}
              data-active={isActive ? 'true' : 'false'}
              className="console-segmented-button text-xs"
            >
              {item.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
