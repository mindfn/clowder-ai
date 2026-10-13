import { type MessageQuoteSource, MessageQuoteSourceSchema, type ThreadArtifactDTO } from '@cat-cafe/shared';
import { type ReactNode, useEffect, useState } from 'react';
import { API_URL } from '@/utils/api-client';
import { WorkspaceFileViewer } from '../workspace/WorkspaceFileViewer';
import { resolveAssetUrl } from './artifact-view';

/** An exact file leaf of the already authorized message; this is a quotation, not a writable content owner. */
export function publishedTextQuoteSource(
  artifact: ThreadArtifactDTO,
  threadId: string | undefined,
  displayDigest: string | undefined,
): MessageQuoteSource | undefined {
  if (
    !threadId ||
    !artifact.sourceMessageId ||
    !artifact.publicationItem ||
    !artifact.url ||
    !/^\/uploads\/[^/?#\u0000]+$/.test(artifact.url) ||
    !displayDigest
  )
    return undefined;
  const source = MessageQuoteSourceSchema.safeParse({
    kind: 'message',
    threadId,
    messageId: artifact.sourceMessageId,
    ...(artifact.catId ? { senderCatId: artifact.catId } : {}),
    artifactFile: {
      item: artifact.publicationItem,
      url: artifact.url,
      fileName: artifact.name,
      messageRevision: String(artifact.createdAt),
      displayDigest: `sha256:${displayDigest}`,
    },
  });
  return source.success ? source.data : undefined;
}

/** Adapt a fetched publication into the original reader, with no workspace locator or write callbacks. */
export function PublishedTextReader({
  artifact,
  content,
  sourceThreadId,
  onBack,
  reviewAction,
}: {
  artifact: ThreadArtifactDTO;
  content: string;
  sourceThreadId?: string;
  onBack: () => void;
  reviewAction?: ReactNode;
}) {
  const [snapshot, setSnapshot] = useState<{ content: string; digest: string }>();
  useEffect(() => {
    let current = true;
    if (!globalThis.crypto?.subtle) return;
    void globalThis.crypto.subtle
      .digest('SHA-256', new TextEncoder().encode(content))
      .then((buffer) => {
        if (current)
          setSnapshot({
            content,
            digest: Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join(''),
          });
      })
      .catch(() => {
        /* Reading remains available; unverifiable bytes cannot produce a source-bound quote. */
      });
    return () => {
      current = false;
    };
  }, [content]);
  const digest = snapshot?.content === content ? snapshot.digest : undefined;
  return (
    <WorkspaceFileViewer
      file={{
        path: artifact.name,
        content,
        sha256: digest ?? '',
        size: new TextEncoder().encode(content).length,
        mime: /\.(md|markdown)$/i.test(artifact.name) ? 'text/markdown' : 'text/plain',
        truncated: false,
      }}
      publication={{
        url: resolveAssetUrl(artifact.url, API_URL) ?? '',
        quoteSource: publishedTextQuoteSource(artifact, sourceThreadId, digest),
      }}
      onBack={onBack}
      reviewAction={reviewAction}
    />
  );
}
