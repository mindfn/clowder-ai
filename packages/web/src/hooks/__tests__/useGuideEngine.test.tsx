import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useGuideEngine } from '@/hooks/useGuideEngine';
import { useGuideStore, type OrchestrationFlow } from '@/stores/guideStore';

const apiFetchMock = vi.fn();

vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

const FLOW: OrchestrationFlow = {
  id: 'add-member',
  name: 'Add Member',
  steps: [
    { id: 'step-1', target: 'hub.trigger', tips: 'Open hub', advance: 'click' },
    { id: 'step-2', target: 'cats.add-member', tips: 'Add member', advance: 'click' },
  ],
};

function Harness() {
  useGuideEngine();
  return null;
}

function dispatchGuideStart(flowId: string, threadId = 'thread-1') {
  window.dispatchEvent(new CustomEvent('guide:start', { detail: { flowId, threadId } }));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('useGuideEngine duplicate start protection', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    apiFetchMock.mockReset();
    useGuideStore.setState({ session: null });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    useGuideStore.setState({ session: null });
  });

  it('does not fetch the same flow twice while the first start is still in flight', async () => {
    const pending = deferred<{ json: () => Promise<OrchestrationFlow> }>();
    apiFetchMock.mockReturnValue(pending.promise);

    act(() => {
      root.render(React.createElement(Harness));
    });

    await act(async () => {
      dispatchGuideStart('add-member');
      dispatchGuideStart('add-member');
      await Promise.resolve();
    });

    expect(apiFetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.resolve({ json: async () => FLOW });
      await pending.promise;
      await Promise.resolve();
    });

    expect(useGuideStore.getState().session?.flow.id).toBe('add-member');
  });

  it('does not reset the current guide when the same start event arrives again after progress', async () => {
    apiFetchMock.mockResolvedValue({ json: async () => FLOW });

    act(() => {
      root.render(React.createElement(Harness));
    });

    await act(async () => {
      dispatchGuideStart('add-member');
      await Promise.resolve();
      await Promise.resolve();
    });

    useGuideStore.getState().advanceStep();
    expect(useGuideStore.getState().session?.currentStepIndex).toBe(1);

    await act(async () => {
      dispatchGuideStart('add-member');
      await Promise.resolve();
    });

    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    expect(useGuideStore.getState().session?.currentStepIndex).toBe(1);
  });
});
