'use client';

import { useEffect, useState } from 'react';
import { Lightbox } from '@/components/Lightbox';
import { useChatStore } from '@/stores/chatStore';
import { useArtworkLightboxScope } from './ArtworkLightboxScope';
import { artworkLightboxSurface } from './artwork-lightbox-surface';
import { useChatArtworkEntry } from './useChatArtworkEntry';
import type { PublishedMessageCoordinate } from './usePublishedContent';

type Entry = ReturnType<ReturnType<typeof useChatArtworkEntry>['source']>;
type Preview = {
  url: string;
  title: string;
  alt: string;
  mediaType: 'image' | 'video';
  caption?: string;
  entry: Entry;
  reason?: string;
  hostThreadId: string;
};

/** Chat media stays above its conversation. The existing owner admits the read before either presentation. */
export function useChatArtworkLightbox(publication?: PublishedMessageCoordinate) {
  const artwork = useChatArtworkEntry(publication);
  const scope = useArtworkLightboxScope();
  const hostThreadId = useChatStore((state) => state.currentThreadId);
  const [preview, setPreview] = useState<Preview | null>(null);
  useEffect(() => {
    if (preview && preview.hostThreadId !== hostThreadId) setPreview(null);
  }, [preview, hostThreadId]);
  const openWorkMode = async (input: Omit<Preview, 'reason' | 'hostThreadId'>) => {
    const result = await artwork.open(input.entry, input.title, 'work-mode');
    if (result.status !== 'opened') return false;
    scope?.close();
    setPreview(null);
    return true;
  };
  const enlarge = async (input: Omit<Preview, 'reason' | 'hostThreadId'>) => {
    if (!input.entry && !artwork.isV2) {
      setPreview({ ...input, hostThreadId });
      return;
    }
    const result = await artwork.open(input.entry, input.title, 'lightbox');
    if (result.status === 'blocked') return;
    if (scope && artwork.isV2) {
      scope.open({
        ...input,
        surface: result.status === 'opened' ? artworkLightboxSurface(result.target, input.title) : null,
        ...(result.status === 'preview' ? { reason: result.reason } : {}),
        ...(input.entry ? { openWorkspace: () => openWorkMode(input) } : {}),
      });
      return;
    }
    setPreview({ ...input, hostThreadId, ...(result.status === 'preview' ? { reason: result.reason } : {}) });
  };
  return {
    ...artwork,
    enlarge,
    openWorkMode,
    lightbox: preview ? (
      <Lightbox
        url={preview.url}
        alt={preview.alt}
        caption={preview.caption}
        mediaType={preview.mediaType}
        annotationUnavailableReason={preview.reason}
        workspaceBusy={artwork.busy}
        workspaceError={artwork.error}
        onOpenWorkspace={preview.entry ? () => openWorkMode(preview) : undefined}
        onClose={() => setPreview(null)}
      />
    ) : null,
  };
}
