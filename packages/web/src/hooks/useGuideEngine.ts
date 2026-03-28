'use client';

import { useEffect } from 'react';
import { GUIDE_FLOWS } from '@/lib/guide-flows';
import { useGuideStore } from '@/stores/guideStore';

/**
 * F150: Guide Engine hook
 *
 * - Listens for guide:start CustomEvent (from MCP → Socket.io bridge)
 * - Listens for guide:control CustomEvent (next/back/skip/exit)
 * - Exposes window helpers for dev testing
 */
export function useGuideEngine() {
  const startGuide = useGuideStore((s) => s.startGuide);
  const nextStep = useGuideStore((s) => s.nextStep);
  const prevStep = useGuideStore((s) => s.prevStep);
  const skipStep = useGuideStore((s) => s.skipStep);
  const exitGuide = useGuideStore((s) => s.exitGuide);

  useEffect(() => {
    const trigger = (flowId: string) => {
      const flow = GUIDE_FLOWS[flowId];
      if (!flow) {
        console.warn(`[Guide] Unknown flow: ${flowId}. Available: ${Object.keys(GUIDE_FLOWS).join(', ')}`);
        return;
      }
      startGuide(flow.id, flow.steps);
    };

    const controlActions: Record<string, () => void> = {
      next: nextStep,
      back: prevStep,
      skip: skipStep,
      exit: exitGuide,
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__startGuide = trigger;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__guideFlows = Object.keys(GUIDE_FLOWS);

    // guide:start from MCP tool bridge
    const handleGuideStart = (e: Event) => {
      const detail = (e as CustomEvent<{ flowId: string }>).detail;
      if (detail?.flowId) trigger(detail.flowId);
    };

    // guide:control from MCP tool bridge
    const handleGuideControl = (e: Event) => {
      const detail = (e as CustomEvent<{ action: string }>).detail;
      const fn = detail?.action ? controlActions[detail.action] : undefined;
      if (fn) fn();
    };

    window.addEventListener('guide:start', handleGuideStart);
    window.addEventListener('guide:control', handleGuideControl);

    return () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (window as any).__startGuide;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (window as any).__guideFlows;
      window.removeEventListener('guide:start', handleGuideStart);
      window.removeEventListener('guide:control', handleGuideControl);
    };
  }, [startGuide, nextStep, prevStep, skipStep, exitGuide]);
}
