'use client';
import type { ThreadArtifactDTO } from '@cat-cafe/shared';
import { type ReactNode, useState } from 'react';
import { ShellGlyph } from '@/components/shell/ShellIcons';
import { useShellCopy } from '@/components/shell/shell-copy';
import { artifactObjectId } from '@/components/workbench/real-surface-adapters';
import { workspaceV3Copy } from '@/components/workspace-home/workspace-v3.shell-copy';
import { useArtifactContent } from '@/hooks/useArtifactContent';
import { API_URL } from '@/utils/api-client';
import { ArtifactDownloadMenu } from './ArtifactDownloadMenu';
import { classifyArtifactView, resolveAssetUrl } from './artifact-view';
import { worksPanelCopy } from './works-panel.shell-copy';
import './work-gallery.css';
function PaperPreview({ artifact }: { artifact: ThreadArtifactDTO }) {
  const body = useArtifactContent(artifact, null, !!artifact.url);
  const t = useShellCopy(workspaceV3Copy);
  return (
    <span className="work-gallery-paper">
      {body.content?.split('\n').slice(0, 8).join('\n') ||
        (body.loading ? t.worksLoading : body.error ? t.worksUnavailable : artifact.name)}
    </span>
  );
}
function WorkPreview({ artifact }: { artifact: ThreadArtifactDTO }) {
  const t = useShellCopy(worksPanelCopy);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const url = artifact.url ? resolveAssetUrl(artifact.url, API_URL) : null;
  if (artifact.type === 'image' && url && failedUrl !== url)
    return (
      // biome-ignore lint/performance/noImgElement: preserve the original authenticated publication URL.
      <img src={url} alt={artifact.name} onError={() => setFailedUrl(url)} />
    );
  if (classifyArtifactView(artifact) === 'text' && /\.(md|markdown|txt)$/i.test(artifact.name))
    return <PaperPreview artifact={artifact} />;
  const type = /\.pdf$/i.test(artifact.name)
    ? 'PDF'
    : /\.pptx?$/i.test(artifact.name)
      ? 'PPT'
      : t.filters[artifact.type === 'pr' || artifact.type === 'code' ? 'codepr' : artifact.type];
  return (
    <span className="work-gallery-kind">
      <ShellGlyph name={artifact.type === 'video' ? 'play' : 'filePen'} className="h-7 w-7" />
      <span>{type}</span>
    </span>
  );
}
/** One card for Workspace Works and new-conversation recent works; each host retains its original owner. */
export function WorkGalleryCard({
  artifact,
  metadata,
  subtitle,
  footer,
  onSelect,
  onOpenSource,
  sourceLabel,
  testId = 'workspace-home-artifact-card',
}: {
  artifact: ThreadArtifactDTO;
  metadata?: string;
  subtitle?: ReactNode;
  footer?: ReactNode;
  onSelect: (card: HTMLButtonElement) => void;
  onOpenSource?: () => void;
  sourceLabel?: string;
  testId?: string;
}) {
  return (
    <article className="work-gallery-card">
      <button
        type="button"
        className="work-gallery-open shell-focusable"
        data-testid={testId}
        data-home-artifact-id={artifactObjectId(artifact)}
        onClick={(event) => onSelect(event.currentTarget)}
      >
        <span className="work-gallery-visual">
          <WorkPreview artifact={artifact} />
        </span>
        <span className="work-gallery-title" title={artifact.name}>
          {artifact.name}
        </span>
        {subtitle && (
          <span className="work-gallery-subtitle" title={typeof subtitle === 'string' ? subtitle : undefined}>
            {subtitle}
          </span>
        )}
      </button>
      <div className="work-gallery-footer">
        {footer ?? <small title={metadata}>{metadata}</small>}
        {onOpenSource && (
          <button
            type="button"
            className="work-gallery-source shell-focusable"
            aria-label={sourceLabel}
            title={sourceLabel}
            onClick={onOpenSource}
          >
            ↗
          </button>
        )}
      </div>
      <ArtifactDownloadMenu artifact={artifact} />
    </article>
  );
}
