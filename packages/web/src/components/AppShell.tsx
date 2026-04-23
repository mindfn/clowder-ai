'use client';

import { ActivityBar } from './ActivityBar';

interface AppShellProps {
  children: React.ReactNode;
}

export function AppShell({ children }: AppShellProps) {
  return (
    <div className="flex h-screen h-dvh">
      <ActivityBar />
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  );
}
