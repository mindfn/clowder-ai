'use client';

import { useEffect } from 'react';
import { GUIDE_FLOWS } from '@/lib/guide-flows';
import { useGuideStore } from '@/stores/guideStore';

/**
 * F150: Guide Engine hook
 *
 * - Exposes guide trigger on window for dev/testing
 * - Listens for socket events to start guides (Phase B)
 * - Provides startGuide helper
 */
export function useGuideEngine() {
  const startGuide = useGuideStore((s) => s.startGuide);

  useEffect(() => {
    // Expose on window for dev testing + MCP tool invocation
    const trigger = (flowId: string) => {
      const flow = GUIDE_FLOWS[flowId];
      if (!flow) {
        console.warn(`[Guide] Unknown flow: ${flowId}. Available: ${Object.keys(GUIDE_FLOWS).join(', ')}`);
        return;
      }
      startGuide(flow.id, flow.steps);
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__startGuide = trigger;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__guideFlows = Object.keys(GUIDE_FLOWS);

    // Custom event listener (for MCP tool bridge)
    const handleGuideEvent = (e: Event) => {
      const detail = (e as CustomEvent<{ flowId: string }>).detail;
      if (detail?.flowId) trigger(detail.flowId);
    };
    window.addEventListener('guide:start', handleGuideEvent);

    return () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (window as any).__startGuide;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (window as any).__guideFlows;
      window.removeEventListener('guide:start', handleGuideEvent);
    };
  }, [startGuide]);
}
