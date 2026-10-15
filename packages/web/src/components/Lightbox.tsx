'use client';

import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { API_URL } from '@/utils/api-client';
import { lightboxCopy } from './lightbox.shell-copy';
import { useShellCopy } from './shell/shell-copy';
import { useShellPresentation } from './shell/shell-presentation';

async function copyImageToClipboard(url: string) {
  const source = new URL(url, window.location.origin);
  const privateDotImage =
    source.origin === new URL(API_URL).origin && source.pathname.startsWith('/api/plugins/chatgpt-dot/images/');
  const res = await fetch(url, privateDotImage ? { credentials: 'include' } : undefined);
  if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
  const blob = await res.blob();
  if (!blob.type.startsWith('image/')) throw new Error(`not an image: ${blob.type}`);
  await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
}

export function CopyButton({ url, placement = 'overlay' }: { url: string; placement?: 'overlay' | 'below' }) {
  const [copied, setCopied] = useState(false);
  const isV2 = useShellPresentation() === 'v2';
  const t = useShellCopy(lightboxCopy);

  const handleCopy = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      try {
        await copyImageToClipboard(url);
      } catch {
        try {
          await navigator.clipboard.writeText(url);
        } catch {
          return;
        }
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    },
    [url],
  );

  return (
    <button
      type="button"
      onClick={handleCopy}
      className={
        placement === 'below'
          ? 'rounded-md border border-cafe-subtle px-2 py-1 text-xs text-cafe-muted hover:text-cafe'
          : 'absolute top-2 right-2 bg-[var(--console-overlay-control)] hover:bg-[var(--console-overlay-control-hover)] text-[var(--overlay-fg)] rounded-md px-2 py-1 text-xs opacity-0 group-hover:opacity-100 transition-opacity'
      }
      title={copied ? (isV2 ? t.copied : 'Copied!') : isV2 ? t.copyImage : 'Copy image'}
    >
      {copied ? (isV2 ? t.copied : 'Copied!') : isV2 ? t.copy : 'Copy'}
    </button>
  );
}

export function Lightbox({
  url,
  alt,
  caption,
  annotationUnavailableReason,
  mediaType = 'image',
  onClose,
}: {
  url: string;
  alt: string;
  caption?: string;
  annotationUnavailableReason?: string;
  mediaType?: 'image' | 'video';
  onClose: () => void;
}) {
  const isV2 = useShellPresentation() === 'v2';
  const t = useShellCopy(lightboxCopy);
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  if (typeof document === 'undefined') {
    return null;
  }

  return createPortal(
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape key handled via useEffect
    <div
      role="dialog"
      aria-modal="true"
      aria-label={alt || (isV2 ? (mediaType === 'image' ? t.imagePreview : t.videoPreview) : 'Image preview')}
      className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--console-overlay-heavy)] backdrop-blur-sm"
      onClick={onClose}
    >
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: stopPropagation only, not interactive */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: container prevents backdrop close */}
      <div
        className="relative group max-w-[90vw] max-h-[90vh] flex flex-col items-center"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={onClose}
          className="absolute -top-3 -right-3 bg-[var(--console-overlay-heavy)] hover:bg-[var(--console-overlay-heavy-hover)] text-[var(--overlay-fg)] rounded-full w-8 h-8 flex items-center justify-center text-lg z-10"
          title={isV2 ? t.close : 'Close'}
        >
          &times;
        </button>
        {/* biome-ignore lint/performance/noImgElement: data URIs from MCP cannot use next/image */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {mediaType === 'video' ? (
          <video
            src={url}
            controls
            preload="metadata"
            aria-label={alt}
            className="max-w-full max-h-[85vh] rounded-lg"
          />
        ) : (
          <img src={url} alt={alt} className="max-w-full max-h-[85vh] object-contain rounded-lg" />
        )}
        {caption && <p className="mt-2 text-sm text-[var(--overlay-fg-muted)]">{caption}</p>}
        {annotationUnavailableReason && (
          <p role="status" className="mt-2 text-sm text-[var(--overlay-fg-muted)]">
            {annotationUnavailableReason}
          </p>
        )}
        {mediaType === 'image' && <CopyButton url={url} />}
      </div>
    </div>,
    document.body,
  );
}
