'use client';

import { useCallback, useState } from 'react';
import { useChatArtworkEntry } from '@/components/content-review/useChatArtworkEntry';
import type { PublishedMessageCoordinate } from '@/components/content-review/usePublishedContent';
import { CopyButton, Lightbox } from '@/components/Lightbox';
import { useShellLanguage } from '@/components/shell/shell-language';
import type { RichMediaGalleryBlock } from '@/stores/chat-types';
import { API_URL } from '@/utils/api-client';
import { isGalleryApiUrl, useGalleryMediaUrls } from './useGalleryMediaUrls';

function resolveMediaUrl(url: string): string {
  return isGalleryApiUrl(url) ? `${API_URL}${url}` : url;
}

export function MediaGalleryBlock({
  block,
  publication,
}: {
  block: RichMediaGalleryBlock;
  publication?: PublishedMessageCoordinate;
}) {
  const items = Array.isArray(block.items) ? block.items : [];
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [previewReason, setPreviewReason] = useState<string | undefined>();
  const [failedUrls, setFailedUrls] = useState<Set<string>>(new Set());
  const mediaUrls = useGalleryMediaUrls(items);
  const language = useShellLanguage();
  const published = useChatArtworkEntry(publication);
  const lightboxItem = lightboxIndex === null ? undefined : items[lightboxIndex];
  const lightboxUrl = lightboxIndex === null ? undefined : mediaUrls[lightboxIndex]?.url;
  const lightboxSrc = lightboxUrl ? resolveMediaUrl(lightboxUrl) : undefined;

  const handleImgError = useCallback((url: string) => {
    setFailedUrls((prev) => {
      const next = new Set(prev);
      next.add(url);
      return next;
    });
  }, []);

  return (
    <>
      <div className="rounded-lg border border-cafe p-3">
        {block.title && <div className="font-medium text-sm mb-2">{block.title}</div>}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {items.map((item, i) => {
            const media = mediaUrls[i];
            if (!media) return null;
            const src = media.url ? resolveMediaUrl(media.url) : '';
            const failed = !media.pending && (!src || failedUrls.has(src));
            const source = published.source(media.url ?? item.url, {
              kind: 'media-gallery',
              blockId: block.id,
              itemIndex: i,
            });
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: gallery items have no stable id
              <figure key={i} className="relative group space-y-1">
                {media.pending ? (
                  <p role="status" className="px-4 py-6 text-xs text-cafe-secondary">
                    {language === 'en' ? 'Loading image…' : '正在读取图片…'}
                  </p>
                ) : failed ? (
                  <div
                    className="rounded w-full flex flex-col items-center justify-center gap-2 bg-[var(--bg-secondary)] text-cafe-secondary px-4 py-6 min-h-[8rem]"
                    data-testid="media-gallery-error"
                  >
                    <span className="text-2xl" aria-hidden="true">
                      🖼️
                    </span>
                    <span className="text-xs font-medium">
                      {language === 'en' ? 'Image address could not be opened' : '图片地址无法打开'}
                    </span>
                    <span className="text-xs text-center">
                      {language === 'en'
                        ? 'Ask the sender to check the image address or send it again.'
                        : '请让发送者检查图片地址或重新发送。'}
                    </span>
                  </div>
                ) : (
                  <button
                    type="button"
                    disabled={published.busy}
                    onClick={async () => {
                      if (!source && !published.isV2) {
                        setLightboxIndex(i);
                        return;
                      }
                      const result = await published.open(source, item.caption ?? item.alt ?? block.title ?? '作品');
                      if (result.status === 'preview' && published.isV2) {
                        setPreviewReason(result.reason);
                        setLightboxIndex(i);
                      }
                    }}
                    className="block w-full rounded focus:outline-2 focus:outline-[var(--semantic-info)]"
                    aria-label={
                      source ? `打开作品 ${item.alt ?? block.title ?? '图片'}` : `Enlarge ${item.alt ?? 'image'}`
                    }
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    {/* biome-ignore lint/performance/noImgElement: data URIs from MCP cannot use next/image */}
                    <img
                      src={src}
                      alt={item.alt ?? ''}
                      onError={() => handleImgError(src)}
                      className="rounded w-full object-cover max-h-48 cursor-pointer hover:opacity-90 transition-opacity"
                    />
                  </button>
                )}
                {src && <CopyButton url={src} placement={published.isV2 ? 'below' : 'overlay'} />}
                {item.caption && <figcaption className="text-xs text-cafe-secondary">{item.caption}</figcaption>}
              </figure>
            );
          })}
        </div>
        {published.busy ? (
          <p role="status" className="mt-2 text-xs text-cafe-muted">
            正在打开作品…
          </p>
        ) : null}
        {published.error ? (
          <p role="alert" className="mt-2 text-xs text-cafe-error">
            {published.error}
          </p>
        ) : null}
      </div>
      {lightboxItem && lightboxSrc && !failedUrls.has(lightboxSrc) && (
        <Lightbox
          url={lightboxSrc}
          alt={lightboxItem.alt ?? ''}
          caption={lightboxItem.caption}
          annotationUnavailableReason={previewReason}
          onClose={() => setLightboxIndex(null)}
        />
      )}
    </>
  );
}
