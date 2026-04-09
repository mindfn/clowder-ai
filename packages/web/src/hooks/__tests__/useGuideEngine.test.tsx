import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useGuideEngine } from '@/hooks/useGuideEngine';
import { type OrchestrationFlow, useGuideStore } from '@/stores/guideStore';

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

function dispatchGuideControl(
  action: 'next' | 'back' | 'skip' | 'exit',
  detail: { guideId?: string; threadId?: string } = {},
) {
  window.dispatchEvent(new CustomEvent('guide:control', { detail: { action, ...detail } }));
}

function dispatchGuideComplete(detail: { guideId?: string; threadId?: string } = {}) {
  window.dispatchEvent(new CustomEvent('guide:complete', { detail }));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  void promise.catch(() => {});
  return { promise, resolve, reject };
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

  it('retries a duplicate guide:start after the in-flight fetch fails', async () => {
    const firstFetch = deferred<{ json: () => Promise<OrchestrationFlow> }>();
    apiFetchMock.mockReturnValueOnce(firstFetch.promise).mockResolvedValueOnce({ json: async () => FLOW });

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
      firstFetch.reject(new Error('temporary failure'));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(apiFetchMock).toHaveBeenCalledTimes(2);
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

  it('applies matching guide:control events to the current session', async () => {
    apiFetchMock.mockResolvedValue({ json: async () => FLOW });

    act(() => {
      root.render(React.createElement(Harness));
    });

    await act(async () => {
      dispatchGuideStart('add-member');
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(useGuideStore.getState().session?.currentStepIndex).toBe(0);

    act(() => {
      dispatchGuideControl('next', { guideId: 'add-member', threadId: 'thread-1' });
    });
    expect(useGuideStore.getState().session?.currentStepIndex).toBe(1);

    act(() => {
      dispatchGuideControl('back', { guideId: 'add-member', threadId: 'thread-1' });
    });
    expect(useGuideStore.getState().session?.currentStepIndex).toBe(0);

    act(() => {
      dispatchGuideControl('exit', { guideId: 'add-member', threadId: 'thread-1' });
    });
    expect(useGuideStore.getState().session).toBeNull();
  });

  it('ignores guide:control events for a different guide or thread', async () => {
    apiFetchMock.mockResolvedValue({ json: async () => FLOW });

    act(() => {
      root.render(React.createElement(Harness));
    });

    await act(async () => {
      dispatchGuideStart('add-member');
      await Promise.resolve();
      await Promise.resolve();
    });

    act(() => {
      dispatchGuideControl('exit', { guideId: 'other-guide', threadId: 'thread-1' });
      dispatchGuideControl('exit', { guideId: 'add-member', threadId: 'thread-2' });
    });

    expect(useGuideStore.getState().session?.flow.id).toBe('add-member');
  });

  it('marks the current session complete on a matching guide:complete event', async () => {
    apiFetchMock.mockResolvedValueOnce({ json: async () => FLOW }).mockResolvedValueOnce({ ok: true });

    act(() => {
      root.render(React.createElement(Harness));
    });

    await act(async () => {
      dispatchGuideStart('add-member');
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(useGuideStore.getState().session?.phase).toBe('locating');

    act(() => {
      dispatchGuideComplete({ guideId: 'add-member', threadId: 'thread-1' });
    });

    expect(useGuideStore.getState().session?.phase).toBe('complete');
  });
});
