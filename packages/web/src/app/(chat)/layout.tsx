'use client';

import { useParams } from 'next/navigation';
import { useCallback, useSyncExternalStore } from 'react';
import { ChatContainer } from '@/components/ChatContainer';
import { CHAT_THREAD_ROUTE_EVENT, getThreadIdFromPathname } from '@/components/ThreadSidebar/thread-navigation';

function subscribeToThreadRoute(onStoreChange: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener('popstate', onStoreChange);
  window.addEventListener(CHAT_THREAD_ROUTE_EVENT, onStoreChange);
  return () => {
    window.removeEventListener('popstate', onStoreChange);
    window.removeEventListener(CHAT_THREAD_ROUTE_EVENT, onStoreChange);
  };
}

function getThreadRouteSnapshot(): string {
  if (typeof window === 'undefined') return 'default';
  return getThreadIdFromPathname(window.location.pathname);
}

/**
 * Shared layout for "/" and "/thread/[threadId]".
 *
 * By placing ChatContainer here instead of in each page, it stays mounted
 * across thread switches — no unmount/remount flicker, no scroll-position
 * loss, and socket/state survives navigation.
 */
export default function ChatLayout({ children }: { children: React.ReactNode }) {
  // Derive server snapshot from route params to avoid hydration mismatch
  // (React error #418). Without this, SSR renders with 'default' while the
  // client reads the real URL, causing a mismatch on /thread/[threadId] pages.
  const params = useParams();
  const paramThreadId = typeof params?.threadId === 'string' ? params.threadId : 'default';
  const getServerSnapshot = useCallback(() => paramThreadId, [paramThreadId]);
  const threadId = useSyncExternalStore(subscribeToThreadRoute, getThreadRouteSnapshot, getServerSnapshot);

  return (
    <>
      <ChatContainer threadId={threadId} />
      {children}
    </>
  );
}
