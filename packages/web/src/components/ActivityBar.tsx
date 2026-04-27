'use client';

import { usePathname, useSearchParams } from 'next/navigation';
import type { CSSProperties } from 'react';
import { MemoryIcon } from './icons/MemoryIcon';
import {
  assignDocumentRoute,
  CLASSIC_WORLD_PREFIX,
  getThreadIdFromPathname,
  getWorldSwitchHref,
} from './ThreadSidebar/thread-navigation';

const NAV_ITEMS = [
  {
    id: 'home',
    path: '/',
    label: '首页',
    accent: 'var(--color-cafe-accent)',
    glow: 'var(--color-cafe-accent)',
    match: (p: string) => p === '/' || p.startsWith('/thread/'),
  },
  {
    id: 'signals',
    path: '/signals',
    label: '信号',
    accent: 'var(--color-gemini-primary)',
    glow: 'var(--color-gemini-bg)',
    match: (p: string) => p.startsWith('/signals'),
  },
  {
    id: 'memory',
    path: '/memory',
    label: '记忆',
    accent: 'var(--color-codex-primary)',
    glow: 'var(--color-codex-bg)',
    match: (p: string) => p.startsWith('/memory'),
  },
  {
    id: 'settings',
    path: '/settings',
    label: '设置',
    accent: 'var(--color-kimi-dark)',
    glow: 'var(--color-kimi-bg)',
    match: (p: string) => p.startsWith('/settings'),
  },
] as const;

function HomeIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className={className}>
      <title>首页</title>
      <path d="M3 10.5 12 3l9 7.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M5.25 9.75V21h13.5V9.75" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M10 21v-5.25h4V21" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SignalIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className={className}>
      <title>信号</title>
      <path
        d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <line x1="4" y1="22" x2="4" y2="15" strokeLinecap="round" />
    </svg>
  );
}

function SettingsIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className={className}>
      <title>设置</title>
      <circle cx="12" cy="12" r="3" />
      <path
        d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ClassicWorldIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className={className}>
      <title>经典世界</title>
      <path d="M12 3v18" strokeLinecap="round" />
      <path d="M4 7h8a4 4 0 1 1 0 8H4Z" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M20 17h-8a4 4 0 1 1 0-8h8Z" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const ICON_MAP: Record<string, ({ className }: { className?: string }) => JSX.Element> = {
  home: HomeIcon,
  signals: SignalIcon,
  memory: MemoryIcon,
  settings: SettingsIcon,
};

interface ActivityBarProps {
  className?: string;
}

export function ActivityBar({ className }: ActivityBarProps) {
  const pathname = usePathname() ?? '/';
  const searchParams = useSearchParams();
  const inClassicWorld = pathname.startsWith('/classic');
  const classicPath = getWorldSwitchHref(pathname, searchParams?.get('from') ?? undefined);
  const classicTitle = inClassicWorld ? '返回新世界' : '切换到经典世界';

  return (
    <nav
      className={`console-activity-rail flex w-12 flex-shrink-0 flex-col items-center gap-1 px-1 py-2 border-r border-[var(--console-border-soft)] ${className ?? ''}`}
      aria-label="主导航"
    >
      {NAV_ITEMS.map((item) => {
        const Icon = ICON_MAP[item.id];
        const active = item.match(pathname);
        const toneStyle = {
          ['--item-accent' as string]: item.accent,
          ['--item-glow' as string]: item.glow,
        } as CSSProperties;
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => {
              const prefix = pathname.startsWith(CLASSIC_WORLD_PREFIX) ? CLASSIC_WORLD_PREFIX : '';
              const threadId = getThreadIdFromPathname(pathname, prefix);
              let referrer = threadId !== 'default' ? threadId : null;
              if (!referrer && typeof window !== 'undefined') {
                referrer = new URLSearchParams(window.location.search).get('from');
              }
              const from = referrer && item.id !== 'home' ? `?from=${encodeURIComponent(referrer)}` : '';
              assignDocumentRoute(`${item.path}${from}`, typeof window !== 'undefined' ? window : undefined);
            }}
            data-active={active ? 'true' : 'false'}
            className={`console-activity-button relative flex h-10 w-10 items-center justify-center rounded-lg ${active ? 'border-l-[3px] border-l-[var(--item-accent,var(--cafe-accent))] bg-[var(--cafe-surface)]' : ''}`}
            style={toneStyle}
            title={item.label}
            aria-current={active ? 'page' : undefined}
          >
            <Icon className="h-5 w-5" />
          </button>
        );
      })}
      <div className="mt-auto flex flex-col items-center pt-3">
        <button
          type="button"
          onClick={() => assignDocumentRoute(classicPath, typeof window !== 'undefined' ? window : undefined)}
          data-active={inClassicWorld ? 'true' : 'false'}
          className={`console-activity-button relative flex h-10 w-10 items-center justify-center rounded-lg ${inClassicWorld ? 'border-l-[3px] border-l-[var(--item-accent,var(--cafe-accent))] bg-[var(--cafe-surface)]' : ''}`}
          style={
            {
              ['--item-accent' as string]: 'var(--color-opus-primary)',
              ['--item-glow' as string]: 'var(--color-opus-bg)',
            } as CSSProperties
          }
          title={classicTitle}
          aria-label={classicTitle}
        >
          <ClassicWorldIcon className="h-5 w-5" />
        </button>
      </div>
    </nav>
  );
}
