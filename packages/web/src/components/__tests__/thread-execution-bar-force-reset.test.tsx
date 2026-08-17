import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useActiveExecutionStore } from '@/stores/activeExecutionStore';
import { useChatStore } from '@/stores/chatStore';
import { ThreadExecutionBar } from '../ThreadExecutionBar';

vi.mock('@/hooks/useCatData', () => ({
  formatCatName: (cat: { displayName?: string; id: string }) => cat.displayName ?? cat.id,
  useCatData: () => ({ getCatById: (id: string) => ({ id, displayName: id, color: { primary: '#9B7EBD' } }) }),
}));

function setActive(catId: string) {
  const request = useActiveExecutionStore.getState().beginHydration('thread-a');
  useActiveExecutionStore.getState().applySnapshot('thread-a', request, {
    projectPath: '/project/cafe',
    executions: [
      {
        executionId: 'inv-a',
        threadId: 'thread-a',
        threadTitle: 'Alpha',
        catId,
        kind: 'live_invocation',
        startedAt: Date.now(),
        cancelability: {
          state: 'cancelable',
          target: { kind: 'live_invocation', threadId: 'thread-a', catId, executionId: 'inv-a' },
        },
      },
    ],
  });
  useChatStore.setState({
    currentThreadId: 'thread-a',
    catStatuses: { [catId]: 'streaming' },
    catInvocations: {},
    threadStates: {},
  });
}

describe('ThreadExecutionBar Stop ownership', () => {
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
    useActiveExecutionStore.getState().reset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it('keeps exact execution cancel and removes the duplicate force-reset entry', async () => {
    setActive('opus');
    await act(async () => root.render(React.createElement(ThreadExecutionBar, { threadId: 'thread-a' })));

    expect(container.querySelector('[aria-label="Stop opus live_invocation inv-a"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="force-reset-entry"]')).toBeNull();
    expect(container.textContent).not.toContain('强制重置');
  });
});
