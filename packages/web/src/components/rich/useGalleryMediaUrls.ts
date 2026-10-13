import { useEffect, useState } from 'react';
import type { RichMediaGalleryBlock } from '@/stores/chat-types';
import { apiFetch } from '@/utils/api-client';

export function isGalleryApiUrl(url: string): boolean {
  return [
    '/uploads/',
    '/api/workspace/file/raw?',
    '/api/connector-media/',
    '/api/plugins/chatgpt-dot/images/',
    '/avatars/',
  ].some((prefix) => url.startsWith(prefix));
}

function isLocalPath(url: string): boolean {
  return !isGalleryApiUrl(url) && (/^\//.test(url) || /^[a-z]:[\\/]/i.test(url) || /^\\\\/.test(url));
}

/** Read-side compatibility for old galleries; resolution never edits the source message. */
export function useGalleryMediaUrls(items: RichMediaGalleryBlock['items']) {
  const [resolved, setResolved] = useState<Record<string, string | null>>({});
  const pathsKey = JSON.stringify([...new Set(items.map((item) => item.url.trim()).filter(isLocalPath))]);
  useEffect(() => {
    const paths: string[] = JSON.parse(pathsKey);
    if (paths.length === 0) return;
    let cancelled = false;
    void Promise.all(
      paths.map(async (href) => {
        try {
          const response = await apiFetch('/api/workspace/resolve-document-link', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ href }),
          });
          if (!response.ok) throw new Error('Local image path unavailable');
          const target: unknown = await response.json();
          if (
            !target ||
            typeof target !== 'object' ||
            !('kind' in target) ||
            target.kind !== 'file' ||
            !('worktreeId' in target) ||
            typeof target.worktreeId !== 'string' ||
            !('path' in target) ||
            typeof target.path !== 'string'
          )
            throw new Error('Invalid workspace image target');
          return [
            href,
            `/api/workspace/file/raw?${new URLSearchParams({ worktreeId: target.worktreeId, path: target.path })}`,
          ] as const;
        } catch {
          return [href, null] as const;
        }
      }),
    ).then((entries) => {
      if (!cancelled) setResolved(Object.fromEntries(entries));
    });
    return () => {
      cancelled = true;
    };
  }, [pathsKey]);

  return items.map((item) => {
    const url = item.url.trim();
    if (isLocalPath(url)) return { url: resolved[url], pending: resolved[url] === undefined };
    const valid =
      isGalleryApiUrl(url) || /^https?:\/\//i.test(url) || /^data:image\//i.test(url) || /^blob:/i.test(url);
    return { url: valid ? url : null, pending: false };
  });
}
