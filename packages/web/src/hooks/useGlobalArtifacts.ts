/**
 * F232 Phase B: Fetch the globally aggregated artifacts across all user threads.
 * Backs ArtifactsPanel in "全局" scope mode. Mirrors useThreadArtifacts' shape
 * (AbortController + apiFetch + refetch) for drop-in scope switching.
 */

import type { GlobalArtifactDTO, GlobalArtifactsResponse } from '@cat-cafe/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '../utils/api-client';
import { usePagedGlobalWorks } from './usePagedGlobalWorks';
import { useWorksSourceRefresh } from './useThreadArtifacts';

type WorkLineage = GlobalArtifactsResponse['workLineage'];

interface GlobalArtifactsPayload {
  artifacts: GlobalArtifactDTO[];
  workLineage: WorkLineage;
  complete: boolean;
}

function parseGlobalArtifactsResponse(body: unknown, requireComplete: boolean): GlobalArtifactsPayload {
  if (body === null || typeof body !== 'object') {
    return { artifacts: [], workLineage: 'unavailable', complete: false };
  }
  const record = body as Record<string, unknown>;
  return {
    artifacts: Array.isArray(record.artifacts) ? (record.artifacts as GlobalArtifactDTO[]) : [],
    workLineage: record.workLineage === 'resolved' ? 'resolved' : 'unavailable',
    complete: typeof record.complete === 'boolean' ? record.complete : !requireComplete,
  };
}

async function fetchGlobalArtifacts(
  path: string,
  signal: AbortSignal,
  requireComplete: boolean,
  worksView: boolean,
): Promise<GlobalArtifactsPayload> {
  const res = await apiFetch(path, { signal });
  if (!res.ok) throw new Error(`global artifacts fetch failed: ${res.status}`);
  const body = await res.json();
  if (worksView && (body === null || typeof body !== 'object' || body.view !== 'works'))
    throw new Error('Works view unavailable');
  return parseGlobalArtifactsResponse(body, requireComplete);
}

interface UseGlobalArtifactsResult {
  artifacts: GlobalArtifactDTO[];
  workLineage: WorkLineage;
  complete: boolean;
  loading: boolean;
  error: boolean;
  loadingMore?: boolean;
  refetch: () => void;
}

export type GlobalArtifactsQuery = { view: 'recent-works'; limit: number } | { view: 'works' };

export function useGlobalArtifacts(enabled: boolean, query?: GlobalArtifactsQuery): UseGlobalArtifactsResult {
  const worksView = query?.view === 'works';
  const paged = usePagedGlobalWorks(enabled && worksView);
  const [artifacts, setArtifacts] = useState<GlobalArtifactDTO[]>([]);
  const [workLineage, setWorkLineage] = useState<WorkLineage>('unavailable');
  const [complete, setComplete] = useState(true);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const enabledRef = useRef(enabled);
  const hostThreadId = useChatStore((state) => state.currentThreadId);

  const requireComplete = query !== undefined;
  const requestPath = query
    ? `/api/artifacts?view=${encodeURIComponent(query.view)}${'limit' in query ? `&limit=${encodeURIComponent(String(query.limit))}` : ''}`
    : '/api/artifacts';

  const refetch = useCallback(async () => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    setLoading(true);
    setError(false);
    setWorkLineage('unavailable');
    try {
      const result = await fetchGlobalArtifacts(requestPath, ac.signal, requireComplete, worksView);
      if (!ac.signal.aborted) {
        setArtifacts(result.artifacts);
        setWorkLineage(result.workLineage);
        setComplete(result.complete);
      }
    } catch (err: unknown) {
      if (ac.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) return;
      setError(true);
      setArtifacts([]);
      setWorkLineage('unavailable');
      setComplete(false);
    } finally {
      if (!ac.signal.aborted) setLoading(false);
    }
  }, [requestPath, requireComplete, worksView]);

  useEffect(() => {
    enabledRef.current = enabled;
    if (enabled && !worksView) {
      refetch();
    } else {
      setArtifacts([]);
      setWorkLineage('unavailable');
      setComplete(true);
      setLoading(false);
      setError(false);
    }
    return () => abortRef.current?.abort();
  }, [enabled, refetch, worksView]);

  useWorksSourceRefresh(hostThreadId, enabled && worksView, paged.restart);

  return worksView
    ? paged
    : { artifacts, workLineage, complete, loading: enabled && (loading || !enabledRef.current), error, refetch };
}
