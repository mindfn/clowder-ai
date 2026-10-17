'use client';

import { type GlobalArtifactDTO, projectThreadWorks, type ThreadArtifactDTO } from '@cat-cafe/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useArtworkLightboxScope } from '@/components/content-review/ArtworkLightboxScope';
import { useArtifactLightbox } from '@/components/content-review/useArtifactLightbox';
import { useShellCopy } from '@/components/shell/shell-copy';
import { pushThreadRouteWithHistory } from '@/components/ThreadSidebar/thread-navigation';
import { artifactObjectId } from '@/components/workbench/real-surface-adapters';
import { artifactCardMetadata } from '@/components/workspace-home/artifact-card-metadata';
import { HomeArtifactLightbox } from '@/components/workspace-home/HomeArtifactLightbox';
import { WorkCard } from '@/components/workspace-home/HomeWorkCard';
import { workspaceV3Copy } from '@/components/workspace-home/workspace-v3.shell-copy';
import { useCatData } from '@/hooks/useCatData';
import { useGlobalArtifacts } from '@/hooks/useGlobalArtifacts';
import { useThreadArtifacts } from '@/hooks/useThreadArtifacts';
import { useChatStore } from '@/stores/chatStore';
import { scrollToMessage } from '@/utils/scrollToMessage';
import { kickTeleportResolve, planTeleport } from '@/utils/teleport';
import { type GroupingMode, groupArtifacts } from './artifact-grouping';
import type { ArtifactListOrigin, ArtifactListView } from './artifact-list-state';
import { useWorksViewportReturn } from './useWorksViewportReturn';
import { worksPanelCopy } from './works-panel.shell-copy';
import '../workspace-home/workspace-v3.css';

export type WorksPanelProps = {
  threadId: string;
  width?: number;
  onClose?: () => void;
  onSelectArtifact?: (artifact: ThreadArtifactDTO | GlobalArtifactDTO, origin: ArtifactListOrigin) => void;
  initialView?: ArtifactListView;
};
type Work = ThreadArtifactDTO | GlobalArtifactDTO;
type Filter = ArtifactListView['filter'];
const sourceThread = (artifact: Work, host: string) => ('threadId' in artifact ? artifact.threadId : host);
const matches = (artifact: Work, filter: Filter) =>
  filter === 'all' ||
  (filter === 'codepr' ? artifact.type === 'code' || artifact.type === 'pr' : artifact.type === filter);

/** The existing artifact-list owner and origin schema, with the original content open callback. */
export function ThreadWorksPanelV2({ threadId, width, onClose, onSelectArtifact, initialView }: WorksPanelProps) {
  const t = useShellCopy(worksPanelCopy);
  const floating = useArtifactLightbox(threadId);
  const floatingScope = useArtworkLightboxScope();
  const cardCopy = useShellCopy(workspaceV3Copy);
  const { getCatById } = useCatData();
  const [scope, setScope] = useState(initialView?.scope ?? 'thread');
  const [filter, setFilter] = useState<Filter>(initialView?.filter ?? 'all');
  const [query, setQuery] = useState(initialView?.query ?? '');
  const [grouping, setGrouping] = useState<GroupingMode>(initialView?.grouping ?? 'time');
  const [catFilter, setCatFilter] = useState<string | null>(initialView?.catFilter ?? null);
  const [collapsed, setCollapsed] = useState(new Set(initialView?.collapsed ?? []));
  const [selected, setSelected] = useState<Work | null>(null);
  const [notice, setNotice] = useState<string | undefined>();
  const previewOrigin = useRef<HTMLButtonElement | null>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const thread = useThreadArtifacts(threadId, 'works');
  const global = useGlobalArtifacts(scope === 'global', { view: 'works' });
  const active = scope === 'global' ? global : thread;
  const globalWorks = useMemo(
    () => projectThreadWorks(global.artifacts, global.workLineage === 'resolved'),
    [global.artifacts, global.workLineage],
  );
  const works: Work[] = scope === 'global' ? globalWorks : thread.works;
  const complete = active.complete && (scope !== 'global' || global.workLineage === 'resolved');
  const author = (id: string | null) => {
    const cat = id ? getCatById(id) : undefined;
    return cat?.nickname?.trim() || cat?.displayName || id || cardCopy.unknownAuthor;
  };
  const meta = (artifact: Work) => artifactCardMetadata(artifact, author(artifact.catId), cardCopy);
  const workKey = (artifact: ThreadArtifactDTO) =>
    JSON.stringify(['threadId' in artifact ? artifact.threadId : threadId, artifactObjectId(artifact)]);
  const authors = [...new Set(works.map((item) => item.catId))];
  const byAuthor =
    scope === 'global' && catFilter !== null ? works.filter((item) => (item.catId ?? '—') === catFilter) : works;
  const visible = byAuthor.filter(
    (item) => matches(item, filter) && item.name.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const groups =
    scope === 'global'
      ? groupArtifacts(visible as GlobalArtifactDTO[], grouping, (id) => author(id))
      : [{ id: '__flat', label: '', count: visible.length, items: visible }];
  useWorksViewportReturn(scroll, initialView?.viewport, !active.loading && !active.error);
  const close = useCallback(() => {
    const ownsFocus = document.activeElement?.closest('.home-lightbox');
    setSelected(null);
    if (ownsFocus && previewOrigin.current?.isConnected) previewOrigin.current.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    setSelected(null);
    setNotice(undefined);
  }, [threadId, scope]);
  const open = (artifact: Work) => {
    const list = scroll.current;
    const card =
      list &&
      [...list.querySelectorAll<HTMLElement>('[data-work-anchor]')].find(
        (node) => node.dataset.workAnchor === workKey(artifact),
      );
    const origin: ArtifactListOrigin = {
      kind: 'artifact-list',
      threadId,
      view: {
        scope,
        filter,
        query,
        grouping,
        catFilter,
        collapsed: [...collapsed],
        ...(list
          ? {
              viewport: {
                scrollTop: Math.max(0, list.scrollTop),
                ...(card
                  ? {
                      anchor: {
                        key: workKey(artifact),
                        offset: card.getBoundingClientRect().top - list.getBoundingClientRect().top,
                      },
                    }
                  : {}),
              },
            }
          : {}),
      },
    };
    const openWorkspace = () => {
      if (onSelectArtifact) onSelectArtifact(artifact, origin);
      else useChatStore.getState().openPublishedArtifact(threadId, artifact, origin);
    };
    if (!floating.open(artifact, origin)) openWorkspace();
  };
  const jump = (artifact: Work) => {
    if (!artifact.sourceMessageId) {
      setNotice(cardCopy.unavailable);
      return;
    }
    const chat = useChatStore.getState();
    const plan = planTeleport({
      threadId: sourceThread(artifact, threadId),
      messageId: artifact.sourceMessageId,
      currentThreadId: chat.currentThreadId,
    });
    if (plan.navigateTo) pushThreadRouteWithHistory(plan.navigateTo, window);
    else if (plan.scrollNow) {
      scrollToMessage(plan.scrollNow);
      kickTeleportResolve();
    }
    chat.closeRightPanel();
  };
  const select = (artifact: Work) => {
    setNotice(undefined);
    if (floatingScope && (artifact.type === 'image' || artifact.type === 'video') && artifact.url) open(artifact);
    else if (artifact.type === 'image' && artifact.url) setSelected(artifact);
    else if (artifact.type === 'widget') jump(artifact);
    else open(artifact);
  };
  const image = selected && active.artifacts.find((item) => workKey(item) === workKey(selected));
  return (
    <section
      className="v2-works-panel"
      data-testid="v2-works-panel"
      style={width ? { width, flexShrink: 0 } : undefined}
    >
      <header className="v2-works-header">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">{t.title}</h2>
          {onClose && (
            <button type="button" className="shell-focusable" aria-label={t.close} onClick={onClose}>
              ×
            </button>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {(['thread', 'global'] as const).map((value) => (
            <button
              key={value}
              type="button"
              className="home-btn shell-focusable"
              aria-pressed={scope === value}
              onClick={() => {
                setScope(value);
                setFilter('all');
                setQuery('');
                setCatFilter(null);
                setCollapsed(new Set());
              }}
            >
              {value === 'thread' ? t.thread : t.global}
            </button>
          ))}
        </div>
        <p className="text-xs text-cafe-muted">
          {active.loading
            ? cardCopy.worksLoading
            : active.error
              ? cardCopy.worksUnavailable
              : complete
                ? t.total(works.length)
                : t.incomplete}
        </p>
        <input
          value={query}
          aria-label={t.search}
          placeholder={t.search}
          onChange={(event) => setQuery(event.target.value)}
          className="v2-works-search shell-focusable"
        />
        <div className="flex flex-wrap gap-2">
          {(Object.keys(t.filters) as Filter[]).map((value) => (
            <button
              type="button"
              key={value}
              className="home-btn shell-focusable"
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
            >
              {t.filters[value]} {complete ? byAuthor.filter((item) => matches(item, value)).length : ''}
            </button>
          ))}
        </div>
        {scope === 'global' && (
          <div className="flex flex-wrap gap-3">
            <label className="text-xs">
              {t.grouping}{' '}
              <select value={grouping} onChange={(e) => setGrouping(e.target.value as GroupingMode)}>
                {(Object.keys(t.groups) as GroupingMode[]).map((key) => (
                  <option key={key} value={key}>
                    {t.groups[key]}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs">
              {t.author}{' '}
              <select value={catFilter ?? ''} onChange={(e) => setCatFilter(e.target.value || null)}>
                <option value="">{t.allAuthors}</option>
                {authors.map((id) => (
                  <option key={id ?? '—'} value={id ?? '—'}>
                    {author(id)}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
        {active.error && (
          <button className="home-btn shell-focusable" type="button" onClick={active.refetch}>
            {t.retry}
          </button>
        )}
        {notice && <output className="text-xs">{notice}</output>}
      </header>
      <div ref={scroll} className="v2-works-scroll">
        {floating.error && <p role="alert">{floating.error}</p>}
        {!active.loading && !active.error && complete && !visible.length && <p className="text-xs">{t.empty}</p>}
        {!active.loading &&
          !active.error &&
          groups.map((group) => (
            <section key={group.id}>
              {group.label && (
                <button
                  type="button"
                  className="v2-works-group shell-focusable"
                  aria-expanded={!collapsed.has(group.id)}
                  onClick={() =>
                    setCollapsed((previous) => {
                      const next = new Set(previous);
                      if (next.has(group.id)) next.delete(group.id);
                      else next.add(group.id);
                      return next;
                    })
                  }
                >
                  {grouping === 'time' ? t.times[group.id as keyof typeof t.times] : group.label} · {group.count}
                </button>
              )}
              {!collapsed.has(group.id) && (
                <div className="v2-works-grid">
                  {group.items.map((artifact) => (
                    <div key={workKey(artifact)} data-work-anchor={workKey(artifact)}>
                      <WorkCard
                        artifact={artifact}
                        summary={false}
                        worktreeId={null}
                        metadata={meta(artifact)}
                        onSelect={(card) => {
                          previewOrigin.current = card;
                          select(artifact);
                        }}
                      />
                      {artifact.sourceMessageId && (
                        <button
                          type="button"
                          className="shell-focusable v2-works-source"
                          onClick={() => jump(artifact)}
                        >
                          {t.original} ↗
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </section>
          ))}
      </div>
      {image && (
        <HomeArtifactLightbox
          artifact={image}
          images={visible.filter((item) => item.type === 'image' && !!item.url)}
          onSelect={setSelected}
          onClose={close}
          onAnnotate={() => {
            open(image);
            close();
          }}
          metadata={meta(image)}
          notice={notice}
          artifactKey={workKey}
        />
      )}
    </section>
  );
}
