'use client';

import type { GlobalArtifactDTO } from '@cat-cafe/shared';
import { useMemo } from 'react';
import { useCatData } from '@/hooks/useCatData';
import { useGlobalArtifacts } from '@/hooks/useGlobalArtifacts';
import { API_URL } from '@/utils/api-client';
import { resolveAssetUrl } from '../artifacts/artifact-view';
import { knownCatName, ShellCatAvatar } from '../shell/ShellCatAvatar';
import { ShellGlyph, WorksIcon } from '../shell/ShellIcons';
import { useShellCopy } from '../shell/shell-copy';
import { formatRelativeTime } from '../ThreadSidebar/thread-utils';
import { newConversationCopy } from './new-conversation.shell-copy';
import { projectRecentWorks } from './recent-works';

function WorkPreview({ artifact }: { artifact: GlobalArtifactDTO }) {
  const resolvedUrl = artifact.type === 'image' ? resolveAssetUrl(artifact.url, API_URL) : undefined;
  if (resolvedUrl) {
    return (
      <span
        aria-hidden="true"
        className="block h-full w-full bg-cover bg-center transition-transform duration-300 group-hover:scale-[1.02]"
        style={{ backgroundImage: `url(${JSON.stringify(resolvedUrl)})` }}
      />
    );
  }
  return (
    <span className="flex h-full w-full items-center justify-center bg-[var(--shell-selected)] text-[var(--shell-muted)]">
      {artifact.type === 'video' ? <ShellGlyph name="play" className="h-8 w-8" /> : <WorksIcon className="h-8 w-8" />}
    </span>
  );
}

function WorkCard({
  artifact,
  onOpen,
}: {
  artifact: GlobalArtifactDTO;
  onOpen: (artifact: GlobalArtifactDTO) => void;
}) {
  const { getCatById } = useCatData();
  const copy = useShellCopy(newConversationCopy);
  const catName = artifact.catId ? (knownCatName(artifact.catId, getCatById) ?? copy.unknownCat) : copy.unknownCat;
  return (
    <button
      type="button"
      className="group min-w-0 text-left shell-focusable"
      onClick={() => onOpen(artifact)}
      data-testid="recent-work-card"
    >
      <span className="block aspect-[16/9] overflow-hidden rounded-xl border border-[var(--shell-hairline)] bg-[var(--shell-paper)] shadow-sm">
        <WorkPreview artifact={artifact} />
      </span>
      <span className="mt-2 block truncate text-compact font-semibold text-[var(--shell-ink)]">{artifact.name}</span>
      <span className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-[var(--shell-muted)]">
        {artifact.catId && <ShellCatAvatar catId={artifact.catId} size={15} />}
        <span className="truncate">{catName}</span>
        <span aria-hidden="true">·</span>
        <span className="shrink-0">{formatRelativeTime(artifact.createdAt)}</span>
      </span>
    </button>
  );
}

export function RecentWorks({
  onOpen,
  onOpenAll,
}: {
  onOpen: (artifact: GlobalArtifactDTO) => void;
  onOpenAll: () => void;
}) {
  const copy = useShellCopy(newConversationCopy);
  const { artifacts, workLineage, complete, loading, error, refetch } = useGlobalArtifacts(true, {
    view: 'recent-works',
    limit: 3,
  });
  const works = useMemo(() => projectRecentWorks(artifacts, workLineage), [artifacts, workLineage]);
  const failed = error || (!complete && works.length === 0);

  return (
    <section aria-labelledby="recent-works-heading" data-testid="recent-works">
      <div className="mb-3 flex items-center gap-3 px-0.5 text-xs text-[var(--shell-muted)]">
        <h2 id="recent-works-heading" className="font-normal">
          {copy.recentWorks}
        </h2>
        <button
          type="button"
          className="shell-focusable ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-1 hover:text-[var(--shell-ink)]"
          onClick={onOpenAll}
        >
          {copy.allWorks}
          <ShellGlyph name="chevronRight" className="h-3 w-3" />
        </button>
      </div>

      {loading && (
        <output className="grid grid-cols-1 gap-5 sm:grid-cols-3" aria-label={copy.loadingWorks} aria-busy="true">
          {[0, 1, 2].map((key) => (
            <div key={key} className="min-w-0 animate-pulse">
              <div className="aspect-[16/9] rounded-xl bg-[var(--shell-selected)]" />
              <div className="mt-2 h-3 w-4/5 rounded bg-[var(--shell-selected)]" />
              <div className="mt-2 h-2.5 w-2/5 rounded bg-[var(--shell-selected)]" />
            </div>
          ))}
        </output>
      )}
      {!loading && failed && (
        <div
          className="flex min-h-24 items-center justify-center gap-3 rounded-xl border border-[var(--shell-hairline)] bg-[var(--shell-paper)] px-4 text-sm text-[var(--shell-muted)]"
          role="alert"
        >
          <span>{copy.worksFailed}</span>
          <button type="button" className="shell-focusable rounded-lg px-2 py-1 text-cafe-accent" onClick={refetch}>
            {copy.retry}
          </button>
        </div>
      )}
      {!loading && !failed && works.length === 0 && (
        <p className="flex min-h-24 items-center justify-center rounded-xl border border-dashed border-[var(--shell-hairline-strong)] px-5 text-center text-sm text-[var(--shell-muted)]">
          {copy.noWorks}
        </p>
      )}
      {!loading && !failed && works.length > 0 && (
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-3">
          {works.map((artifact) => (
            <WorkCard
              key={`${artifact.threadId}:${artifact.sourceMessageId ?? ''}:${artifact.createdAt}:${artifact.name}`}
              artifact={artifact}
              onOpen={onOpen}
            />
          ))}
        </div>
      )}
    </section>
  );
}
