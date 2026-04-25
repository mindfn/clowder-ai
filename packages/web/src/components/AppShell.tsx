'use client';

import { usePathname } from 'next/navigation';
import { ActivityBar } from './ActivityBar';

const CHROMELESS_ROUTES = ['/story-export', '/pixel-brawl', '/showcase'];

interface AppShellProps {
  children: React.ReactNode;
}

export function AppShell({ children }: AppShellProps) {
  const pathname = usePathname() ?? '/';
  const isExport =
    typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('export') === 'true';
  if (isExport || CHROMELESS_ROUTES.some((r) => pathname.startsWith(r))) {
    return <>{children}</>;
  }
  return (
    <div className="console-shell flex h-screen h-dvh overflow-hidden">
      <ActivityBar />
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  );
}
