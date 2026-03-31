'use client';

import { useEffect } from 'react';
import type { OrchestrationFlow } from '@/stores/guideStore';
import { useGuideStore } from '@/stores/guideStore';
import { apiFetch } from '@/utils/api-client';

/**
 * F150: Guide Engine hook (v2 — tag-based engine)
 *
 * - Listens for guide:start CustomEvent (from InteractiveBlock callback)
 * - Fetches flow definition from API at runtime (no build-time catalog)
 * - Exposes window.__startGuide for dev testing
 */
export function useGuideEngine() {
  const startGuide = useGuideStore((s) => s.startGuide);
  const exitGuide = useGuideStore((s) => s.exitGuide);

  useEffect(() => {
    const trigger = async (flowId: string) => {
      try {
        const res = await apiFetch(`/api/guide-flows/${encodeURIComponent(flowId)}`);
        const flow = (await res.json()) as OrchestrationFlow;
        if (!flow?.steps?.length) {
          console.warn(`[Guide] Empty flow: ${flowId}`);
          return;
        }
        startGuide(flow);
      } catch (err) {
        console.error(`[Guide] Failed to fetch flow "${flowId}":`, err);
      }
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__startGuide = trigger;

    const handleGuideStart = (e: Event) => {
      const detail = (e as CustomEvent<{ flowId: string }>).detail;
      if (detail?.flowId) trigger(detail.flowId);
    };

    window.addEventListener('guide:start', handleGuideStart);
    return () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (window as any).__startGuide;
      window.removeEventListener('guide:start', handleGuideStart);
    };
  }, [startGuide, exitGuide]);
}
