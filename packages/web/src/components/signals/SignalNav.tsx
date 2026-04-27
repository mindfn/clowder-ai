import Link from 'next/link';
import React, { useEffect, useMemo, useState } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { detectRoutePrefix, getThreadHref } from '../ThreadSidebar/thread-navigation';

export type SignalNavItem = 'chat' | 'signals' | 'sources' | 'study';

interface SignalNavProps {
  readonly active: SignalNavItem;
  readonly initialReferrerThread?: string | null;
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
function useReferrerThread(initialReferrerThread: string | null): string | null {
  const storeThreadId = useChatStore((s) => s.currentThreadId);
  const [fromParam, setFromParam] = useState<string | null>(initialReferrerThread);
  useEffect(() => {
    const nextFromParam = new URLSearchParams(window.location.search).get('from');
    if (nextFromParam) setFromParam(nextFromParam);
  }, [initialReferrerThread]);
  return useMemo(() => {
    if (fromParam) return fromParam;
    return storeThreadId && storeThreadId !== 'default' ? storeThreadId : null;
  }, [fromParam, storeThreadId]);
}

export function SignalNav({ active, initialReferrerThread = null }: SignalNavProps) {
  const referrerThread = useReferrerThread(initialReferrerThread);
  const fromSuffix = referrerThread ? `?from=${encodeURIComponent(referrerThread)}` : '';

  const items: readonly ItemConfig[] = useMemo(
    () => [
      { id: 'signals' as const, href: `/signals${fromSuffix}`, label: '收件箱' },
      { id: 'sources' as const, href: `/signals/sources${fromSuffix}`, label: '信号源' },
      { id: 'study' as const, href: '', label: '研读队列' },
    ],
    [fromSuffix],
  );

  const backHref = getThreadHref(referrerThread ?? 'default', detectRoutePrefix());

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
          const isDisabled = !item.href;
          if (isDisabled) {
            return (
              <span
                key={item.id}
                data-active="false"
                className="console-segmented-button text-xs opacity-50 cursor-not-allowed"
                title="即将上线"
              >
                {item.label}
              </span>
            );
          }
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
