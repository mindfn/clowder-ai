import {
  type GlobalArtifactsResponse,
  type GlobalWorksPageResponse,
  type ThreadArtifactsResponse,
} from '@cat-cafe/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { mergeArtifactPages } from '@/lib/merge-artifact-pages';
import { apiFetch } from '@/utils/api-client';

type Lineage = GlobalArtifactsResponse['workLineage'];
type Snapshot = {
  artifacts: import('@cat-cafe/shared').GlobalArtifactDTO[];
  workLineage: Lineage;
  complete: boolean;
  loading: boolean;
  loadingMore: boolean;
  error: boolean;
};
const empty = (): Snapshot => ({
  artifacts: [],
  workLineage: 'resolved',
  complete: false,
  loading: true,
  loadingMore: false,
  error: false,
});

class WorksCursorExpired extends Error {}
class ThreadWorksReadError extends Error {
  constructor(readonly status: number) {
    super(`Thread Works read failed: ${status}`);
  }
}

async function fetchPage(token: string | undefined, signal: AbortSignal): Promise<GlobalWorksPageResponse> {
  const response = await apiFetch(
    `/api/artifacts?view=works&read=pages${token ? `&cursor=${encodeURIComponent(token)}` : ''}`,
    { signal },
  );
  if (response.status === 400 || response.status === 409) throw new WorksCursorExpired();
  if (!response.ok) throw new Error(`Works page failed: ${response.status}`);
  const body: GlobalWorksPageResponse = await response.json();
  if (body.view !== 'works' || !Array.isArray(body.artifacts) || typeof body.complete !== 'boolean')
    throw new Error('Invalid Works page');
  if (body.nextCursor !== undefined && (typeof body.nextCursor !== 'string' || !body.nextCursor))
    throw new Error('Invalid Works cursor');
  if (body.complete ? !!body.nextCursor : !body.nextCursor) throw new Error('Invalid Works continuation');
  return body;
}

async function fetchThreadWorks(threadId: string, signal: AbortSignal): Promise<ThreadArtifactsResponse> {
  const response = await apiFetch(`/api/threads/${encodeURIComponent(threadId)}/artifacts?view=works`, { signal });
  if (!response.ok) throw new ThreadWorksReadError(response.status);
  const body: ThreadArtifactsResponse = await response.json();
  if (body.threadId !== threadId || body.view !== 'works' || !Array.isArray(body.artifacts) || body.complete !== true)
    throw new Error('Invalid thread Works response');
  return body;
}

/**
 * Quiet time after a global walk settles before a source change may start another one. A walk
 * re-reads the whole owner catalogue (≈120 pages on the 2026-10-24 runtime), so source changes
 * from a busy host thread are coalesced instead of aborting and restarting from page one.
 */
export const GLOBAL_WORKS_SOURCE_REFRESH_COOLDOWN_MS = 30_000;

const tabHidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';

function replaceThreadSnapshot(
  snapshot: Snapshot,
  body: ThreadArtifactsResponse,
  threadId: string,
  requestedTitle?: string,
): Snapshot {
  const existingTitle = snapshot.artifacts.find((item) => item.threadId === threadId)?.threadTitle;
  const threadTitle = requestedTitle ?? existingTitle ?? '';
  const workLineage: Lineage =
    snapshot.workLineage === 'resolved' && body.workLineage === 'resolved' ? 'resolved' : 'unavailable';
  return {
    ...snapshot,
    artifacts: mergeArtifactPages(
      snapshot.artifacts.filter((item) => item.threadId !== threadId),
      body.artifacts.map((item) => ({ ...item, threadId, threadTitle })),
      workLineage,
    ),
    workLineage,
    complete: true,
    loading: false,
    loadingMore: false,
    error: false,
  };
}

function threadReadFailure(error: unknown): 'clear' | 'remove' | 'stale' {
  if (!(error instanceof ThreadWorksReadError)) return 'stale';
  if (error.status === 401) return 'clear';
  if (error.status === 403 || error.status === 404) return 'remove';
  return 'stale';
}

/** Drain bounded requests serially, publishing useful batches while the original catalogue is still being read. */
export function usePagedGlobalWorks(enabled: boolean, ownerKey?: string | null) {
  const [snapshot, setSnapshot] = useState<Snapshot>(empty);
  const current = useRef<Snapshot>(empty());
  const confirmed = useRef<Snapshot | null>(null);
  const cursor = useRef<string | undefined>();
  const request = useRef<AbortController | null>(null);
  const cursorExpired = useRef(false);
  const owner = useRef(ownerKey);
  const walking = useRef(false);
  const settledAt = useRef(Number.NEGATIVE_INFINITY);
  const refreshPending = useRef(false);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const armRefresh = useRef(() => {});
  const catalogueGeneration = useRef(0);
  const globalCatalogueComplete = useRef(false);
  const invalidThreads = useRef(new Set<string>());
  const retryBlockedThreads = useRef(new Set<string>());
  const threadRefreshVersions = useRef(new Map<string, number>());
  const pendingThreadRefreshes = useRef(new Map<string, string | undefined>());
  const drainingThreadRefreshes = useRef(false);
  const drainThreadRefreshes = useRef(() => {});
  const read = useCallback(async (restart: boolean) => {
    request.current?.abort();
    const ac = new AbortController();
    request.current = ac;
    walking.current = true;
    const retained = restart ? confirmed.current : null;
    if (restart) {
      catalogueGeneration.current += 1;
      globalCatalogueComplete.current = false;
      invalidThreads.current.clear();
      retryBlockedThreads.current.clear();
      threadRefreshVersions.current.clear();
      pendingThreadRefreshes.current.clear();
      current.current = empty();
      cursor.current = undefined;
      cursorExpired.current = false;
    }
    const publish = (patch: Partial<Snapshot>) => {
      current.current = { ...current.current, ...patch };
      if (current.current.error) confirmed.current = null;
      else if (current.current.complete) confirmed.current = current.current;
      // Rebuild independently; a partial replacement is not a new exact total.
      setSnapshot(
        retained && current.current.loadingMore && !current.current.error
          ? { ...retained, loadingMore: true }
          : current.current,
      );
    };
    publish({ loading: current.current.artifacts.length === 0, loadingMore: true, error: false });
    const visited = new Set<string>();
    try {
      for (;;) {
        const token = cursor.current;
        const body = await fetchPage(token, ac.signal);
        if (ac.signal.aborted) return;
        if (body.nextCursor && (body.nextCursor === token || visited.has(body.nextCursor)))
          throw new Error('Works cursor did not advance');
        if (body.nextCursor) visited.add(body.nextCursor);
        const workLineage =
          current.current.workLineage === 'resolved' && body.workLineage === 'resolved' ? 'resolved' : 'unavailable';
        const artifacts = mergeArtifactPages(current.current.artifacts, body.artifacts, workLineage);
        cursor.current = body.nextCursor;
        globalCatalogueComplete.current = body.complete;
        publish({
          artifacts,
          workLineage,
          complete: body.complete && invalidThreads.current.size === 0,
          loading: artifacts.length === 0 && !body.complete,
          loadingMore: !body.complete,
        });
        if (body.complete) break;
      }
    } catch (error) {
      if (!ac.signal.aborted) {
        globalCatalogueComplete.current = false;
        cursorExpired.current = error instanceof WorksCursorExpired;
        publish({ error: true, complete: false, loading: false, loadingMore: false });
      }
    } finally {
      if (request.current === ac) {
        walking.current = false;
        settledAt.current = Date.now();
        if (!ac.signal.aborted) {
          armRefresh.current();
          drainThreadRefreshes.current();
        }
      }
    }
  }, []);
  const replaceThread = useCallback(async (threadId: string, requestedTitle?: string) => {
    const generation = catalogueGeneration.current;
    const refreshVersion = threadRefreshVersions.current.get(threadId);
    const ac = new AbortController();
    try {
      const body = await fetchThreadWorks(threadId, ac.signal);
      if (
        generation !== catalogueGeneration.current ||
        refreshVersion !== threadRefreshVersions.current.get(threadId) ||
        !globalCatalogueComplete.current
      )
        return;
      invalidThreads.current.delete(threadId);
      retryBlockedThreads.current.delete(threadId);
      threadRefreshVersions.current.delete(threadId);
      const replacement = replaceThreadSnapshot(current.current, body, threadId, requestedTitle);
      const complete = invalidThreads.current.size === 0;
      const next = { ...replacement, complete, loadingMore: !complete, error: retryBlockedThreads.current.size > 0 };
      current.current = next;
      confirmed.current = complete ? next : null;
      setSnapshot(next);
    } catch (error) {
      if (
        generation !== catalogueGeneration.current ||
        refreshVersion !== threadRefreshVersions.current.get(threadId) ||
        ac.signal.aborted
      )
        return;
      const failure = threadReadFailure(error);
      if (failure === 'remove') {
        invalidThreads.current.delete(threadId);
        retryBlockedThreads.current.delete(threadId);
        threadRefreshVersions.current.delete(threadId);
        const complete = globalCatalogueComplete.current && invalidThreads.current.size === 0;
        const next = {
          ...current.current,
          artifacts: current.current.artifacts.filter((item) => item.threadId !== threadId),
          complete,
          loading: false,
          loadingMore: !complete,
          error: retryBlockedThreads.current.size > 0,
        };
        current.current = next;
        confirmed.current = complete ? next : null;
        setSnapshot(next);
        return;
      }
      if (failure === 'clear') {
        globalCatalogueComplete.current = false;
        invalidThreads.current.clear();
        retryBlockedThreads.current.clear();
        threadRefreshVersions.current.clear();
        pendingThreadRefreshes.current.clear();
        const next = { ...empty(), loading: false, error: true };
        current.current = next;
        confirmed.current = null;
        setSnapshot(next);
        return;
      }
      retryBlockedThreads.current.add(threadId);
      pendingThreadRefreshes.current.set(threadId, requestedTitle);
      const next = { ...current.current, complete: false, loading: false, loadingMore: false, error: true };
      current.current = next;
      confirmed.current = null;
      setSnapshot(next);
    }
  }, []);
  drainThreadRefreshes.current = () => {
    if (walking.current || drainingThreadRefreshes.current || tabHidden() || !globalCatalogueComplete.current) return;
    const next = [...pendingThreadRefreshes.current.entries()].find(
      ([threadId]) => !retryBlockedThreads.current.has(threadId),
    );
    if (!next) return;
    pendingThreadRefreshes.current.delete(next[0]);
    drainingThreadRefreshes.current = true;
    void replaceThread(...next).finally(() => {
      drainingThreadRefreshes.current = false;
      drainThreadRefreshes.current();
    });
  };
  // A pending source refresh starts only when no walk is running, the tab is visible and the
  // cooldown since the last settled walk has elapsed; otherwise settle/visibility re-arms it.
  armRefresh.current = () => {
    if (!refreshPending.current || walking.current || refreshTimer.current || tabHidden()) return;
    const wait = Math.max(0, settledAt.current + GLOBAL_WORKS_SOURCE_REFRESH_COOLDOWN_MS - Date.now());
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null;
      if (!refreshPending.current || walking.current || tabHidden()) return;
      refreshPending.current = false;
      void read(true);
    }, wait);
  };
  const cancelRefresh = useCallback(() => {
    refreshPending.current = false;
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = null;
  }, []);
  const restart = useCallback(() => {
    void read(true);
  }, [read]);
  const refetch = useCallback(() => {
    if (globalCatalogueComplete.current && retryBlockedThreads.current.size > 0) {
      retryBlockedThreads.current.clear();
      drainThreadRefreshes.current();
      return;
    }
    void read(!current.current.error || cursorExpired.current);
  }, [read]);
  /** Source-change entry point: never aborts a running walk, and coalesces bursts into one later walk. */
  const scheduleRefresh = useCallback(() => {
    refreshPending.current = true;
    armRefresh.current();
  }, []);
  /** Replace one known thread slice without restarting the complete owner catalogue walk. */
  const refreshThread = useCallback((threadId: string, threadTitle?: string) => {
    invalidThreads.current.add(threadId);
    retryBlockedThreads.current.delete(threadId);
    threadRefreshVersions.current.set(threadId, (threadRefreshVersions.current.get(threadId) ?? 0) + 1);
    pendingThreadRefreshes.current.set(threadId, threadTitle);
    const next = {
      ...current.current,
      complete: false,
      loadingMore: globalCatalogueComplete.current,
      error: retryBlockedThreads.current.size > 0,
    };
    current.current = next;
    confirmed.current = null;
    setSnapshot(next);
    drainThreadRefreshes.current();
  }, []);
  useEffect(() => {
    if (owner.current !== ownerKey) {
      confirmed.current = null;
      owner.current = ownerKey;
    }
    cancelRefresh();
    if (enabled) restart();
    else {
      catalogueGeneration.current += 1;
      globalCatalogueComplete.current = false;
      invalidThreads.current.clear();
      retryBlockedThreads.current.clear();
      threadRefreshVersions.current.clear();
      pendingThreadRefreshes.current.clear();
      current.current = empty();
      confirmed.current = null;
      cursor.current = undefined;
      setSnapshot(current.current);
    }
    return () => {
      cancelRefresh();
      catalogueGeneration.current += 1;
      globalCatalogueComplete.current = false;
      invalidThreads.current.clear();
      retryBlockedThreads.current.clear();
      threadRefreshVersions.current.clear();
      pendingThreadRefreshes.current.clear();
      request.current?.abort();
    };
  }, [cancelRefresh, enabled, restart, ownerKey]);
  useEffect(() => {
    if (!enabled) return;
    const onVisibility = () => {
      if (!tabHidden()) {
        armRefresh.current();
        drainThreadRefreshes.current();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [enabled]);
  const visible = owner.current === ownerKey ? snapshot : empty();
  return { ...visible, loading: enabled && visible.loading, refetch, restart, scheduleRefresh, refreshThread };
}
