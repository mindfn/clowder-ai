import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { GuideOverlay } from '@/components/GuideOverlay';
import type { OrchestrationFlow } from '@/stores/guideStore';
import { useGuideStore } from '@/stores/guideStore';

vi.mock('@/hooks/useGuideEngine', () => ({
  useGuideEngine: () => {},
}));

const FLOW: OrchestrationFlow = {
  id: 'listener-cleanup',
  name: 'Listener Cleanup',
  steps: [
    { id: 'step-1', target: 'hub.trigger', tips: 'step 1', advance: 'click' },
    { id: 'step-2', target: 'hub.trigger', tips: 'step 2', advance: 'click' },
    { id: 'step-3', target: 'hub.trigger', tips: 'step 3', advance: 'click' },
  ],
};

describe('GuideOverlay auto-advance lifecycle', () => {
  let container: HTMLDivElement;
  let root: Root;
  let target: HTMLButtonElement;
  let rafId = 0;
  const rafHandles = new Map<number, ReturnType<typeof setTimeout>>();

  beforeAll(() => {
    (globalThis as Record<string, unknown>).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as Record<string, unknown>).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      const id = ++rafId;
      const handle = setTimeout(() => cb(performance.now()), 16);
      rafHandles.set(id, handle);
      return id;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      const handle = rafHandles.get(id);
      if (handle) {
        clearTimeout(handle);
        rafHandles.delete(id);
      }
    });

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    target = document.createElement('button');
    target.setAttribute('data-guide-id', 'hub.trigger');
    target.textContent = 'Hub';
    document.body.appendChild(target);

    act(() => {
      root.render(React.createElement(GuideOverlay));
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    target.remove();
    act(() => {
      useGuideStore.getState().exitGuide();
    });
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    rafHandles.clear();
  });

  it('does not accumulate click listeners across exit + restart', () => {
    act(() => {
      useGuideStore.getState().startGuide(FLOW);
      useGuideStore.getState().setPhase('active');
    });
    act(() => {
      vi.advanceTimersByTime(120);
    });

    act(() => {
      useGuideStore.getState().exitGuide();
    });

    act(() => {
      useGuideStore.getState().startGuide(FLOW);
      useGuideStore.getState().setPhase('active');
    });
    act(() => {
      vi.advanceTimersByTime(120);
    });

    act(() => {
      target.click();
    });
    act(() => {
      vi.advanceTimersByTime(350);
    });

    expect(useGuideStore.getState().session?.currentStepIndex).toBe(1);
  });
});
