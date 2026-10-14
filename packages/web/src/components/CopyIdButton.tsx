'use client';

import { useCallback, useRef, useState } from 'react';

/** Hover-visible button that copies messageId to clipboard. */
export function CopyIdButton({ messageId, label }: { messageId: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>();

  const handleClick = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(messageId);
      setCopied(true);
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable (insecure context / permission denied) — no-op
    }
  }, [messageId]);

  if (label)
    return (
      <button
        type="button"
        role="menuitem"
        aria-label={label}
        onClick={handleClick}
        className="min-h-11 w-full px-3 py-2 text-left text-sm text-cafe-secondary hover:bg-cafe-surface-elevated"
      >
        {copied ? '✓ ' : ''}
        {label}
      </button>
    );

  return (
    <button
      type="button"
      onClick={handleClick}
      tabIndex={-1}
      className="opacity-0 group-hover:opacity-100 transition-opacity text-xs text-cafe-muted hover:text-cafe-secondary cursor-pointer select-none"
      title={messageId}
      aria-label={`复制消息 ID: ${messageId}`}
    >
      {copied ? '✓' : '#'}
    </button>
  );
}
