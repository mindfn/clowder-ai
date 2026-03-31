'use client';

import type { RichVideoBlock } from '@/stores/chat-types';

function isSafeUrl(url: string): boolean {
  return /^\/api\//.test(url) || /^https:\/\//.test(url);
}

export function VideoBlock({ block }: { block: RichVideoBlock }) {
  const safeUrl = isSafeUrl(block.url) ? block.url : undefined;

  if (!safeUrl) {
    return (
      <div className="rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-2 text-xs text-gray-400">
        Invalid video URL
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
      {block.title && (
        <div className="px-3 py-2 text-sm font-medium text-cafe-black dark:text-gray-200 border-b border-gray-200 dark:border-gray-700">
          {block.title}
        </div>
      )}
      <video
        src={safeUrl}
        poster={block.poster}
        controls
        preload="metadata"
        className="w-full max-h-[480px]"
        style={{ maxWidth: block.width ? `${block.width}px` : undefined }}
      >
        <track kind="captions" />
      </video>
    </div>
  );
}
