'use client';

import { usePathname, useRouter } from 'next/navigation';
import { MemoryIcon } from './icons/MemoryIcon';

const NAV_ITEMS = [
  { id: 'chat', path: '/', label: '对话', match: (p: string) => p === '/' || p.startsWith('/thread/') },
  { id: 'signals', path: '/signals', label: '信号', match: (p: string) => p.startsWith('/signals') },
  { id: 'memory', path: '/memory', label: '记忆', match: (p: string) => p.startsWith('/memory') },
  { id: 'settings', path: '/settings', label: '设置', match: (p: string) => p.startsWith('/settings') },
] as const;

function ChatIcon({ className = 'w-5 h-5' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className={className}>
      <title>对话</title>
      <path
        d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
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

const ICON_MAP: Record<string, React.FC<{ className?: string }>> = {
  chat: ChatIcon,
  signals: SignalIcon,
  memory: MemoryIcon,
  settings: SettingsIcon,
};

interface ActivityBarProps {
  className?: string;
}

export function ActivityBar({ className }: ActivityBarProps) {
  const pathname = usePathname() ?? '/';
  const router = useRouter();

  return (
    <nav
      className={`flex flex-col items-center w-12 flex-shrink-0 py-3 gap-1
        bg-cafe-surface-sunken border-r border-cafe-border ${className ?? ''}`}
      aria-label="主导航"
    >
      {NAV_ITEMS.map((item) => {
        const Icon = ICON_MAP[item.id];
        const active = item.match(pathname);
        return (
          <button
            key={item.id}
            onClick={() => router.push(item.path)}
            className={`relative w-10 h-10 flex items-center justify-center rounded-lg
              transition-colors duration-150
              ${
                active
                  ? 'text-cocreator bg-cafe-surface'
                  : 'text-cafe-muted hover:text-cafe-secondary hover:bg-cafe-surface-elevated'
              }`}
            title={item.label}
            aria-current={active ? 'page' : undefined}
          >
            {active && <span className="absolute left-0 top-2 bottom-2 w-0.5 rounded-r bg-cocreator" />}
            <Icon className="w-5 h-5" />
          </button>
        );
      })}
    </nav>
  );
}
