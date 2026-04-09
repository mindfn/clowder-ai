'use client';

import { useEffect, useRef } from 'react';
import type { OrchestrationFlow } from '@/stores/guideStore';
import { useGuideStore } from '@/stores/guideStore';
import { apiFetch } from '@/utils/api-client';

/**
 * F150: Guide Engine hook (v2 — tag-based engine)
 *
 * - Listens for guide:start CustomEvent (from InteractiveBlock callback)
 * - Fetches flow definition from API at runtime (no build-time catalog)
 * - On completion, notifies backend to transition guideState active → completed
 * - Exposes window.__startGuide for dev testing
 */
export function useGuideEngine() {
  const startGuide = useGuideStore((s) => s.startGuide);
  const advanceStep = useGuideStore((s) => s.advanceStep);
  const retreatStep = useGuideStore((s) => s.retreatStep);
  const exitGuide = useGuideStore((s) => s.exitGuide);
  const startInFlightRef = useRef<string | null>(null);

  // Start listener: fetch flow + trigger overlay
  useEffect(() => {
    const hasActiveSession = (flowId: string, threadId?: string) => {
      const session = useGuideStore.getState().session;
      return (
        !!session &&
        session.flow.id === flowId &&
        session.threadId === (threadId ?? null) &&
        session.phase !== 'complete'
      );
    };

    const trigger = async (flowId: string, threadId?: string) => {
      const startKey = `${threadId ?? 'no-thread'}::${flowId}`;
      if (hasActiveSession(flowId, threadId) || startInFlightRef.current === startKey) {
        return;
      }
      startInFlightRef.current = startKey;
      try {
        const res = await apiFetch(`/api/guide-flows/${encodeURIComponent(flowId)}`);
        const flow = (await res.json()) as OrchestrationFlow;
        if (!flow?.steps?.length) {
          console.warn(`[Guide] Empty flow: ${flowId}`);
          return;
        }
        if (hasActiveSession(flowId, threadId)) return;
        startGuide(flow, threadId);
      } catch (err) {
        console.error(`[Guide] Failed to fetch flow "${flowId}":`, err);
      } finally {
        if (startInFlightRef.current === startKey) {
          startInFlightRef.current = null;
        }
      }
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__startGuide = trigger;

    const handleGuideStart = (e: Event) => {
      const detail = (e as CustomEvent<{ flowId: string; threadId?: string }>).detail;
      if (detail?.flowId) trigger(detail.flowId, detail.threadId);
    };

    const handleGuideControl = (e: Event) => {
      const detail = (
        e as CustomEvent<{
          action: 'next' | 'back' | 'skip' | 'exit';
          guideId?: string;
          threadId?: string;
        }>
      ).detail;
      if (!detail?.action) return;

      const session = useGuideStore.getState().session;
      if (!session) return;
      if (detail.guideId && detail.guideId !== session.flow.id) return;
      if (detail.threadId && detail.threadId !== session.threadId) return;

      switch (detail.action) {
        case 'next':
        case 'skip':
          advanceStep();
          break;
        case 'back':
          retreatStep();
          break;
        case 'exit':
          exitGuide();
          break;
      }
    };

    window.addEventListener('guide:start', handleGuideStart);
    window.addEventListener('guide:control', handleGuideControl);
    return () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (window as any).__startGuide;
      window.removeEventListener('guide:start', handleGuideStart);
      window.removeEventListener('guide:control', handleGuideControl);
    };
  }, [advanceStep, exitGuide, retreatStep, startGuide]);

  // Completion callback: when phase becomes 'complete', notify backend
  const session = useGuideStore((s) => s.session);
  useEffect(() => {
    if (!session || session.phase !== 'complete') return;
    const { threadId } = session;
    const guideId = session.flow.id;
    if (!threadId) return;

    const notify = async (attempt = 1) => {
      try {
        const res = await apiFetch('/api/guide-actions/complete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ threadId, guideId }),
        });
        if (!res.ok && attempt < 2) {
          console.warn(`[Guide] Completion callback ${res.status}, retrying…`);
          notify(2);
          return;
        }
        if (!res.ok) {
          console.error(`[Guide] Completion callback failed: ${res.status}`);
        }
      } catch (err) {
        if (attempt < 2) {
          console.warn('[Guide] Completion callback error, retrying…', err);
          notify(2);
          return;
        }
        console.error('[Guide] Completion callback failed after retry:', err);
      }
    };
    notify();
  }, [session?.phase, session?.flow.id, session?.threadId, session]);
}
