import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatStatusType } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { ThreadExecutionBar } from '../ThreadExecutionBar';

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(async () => new Response('{"ok":true,"cancelled":true}', { status: 200 })),
}));

vi.mock('@/hooks/useCatData', () => ({
  formatCatName: (cat: { displayName?: string; id: string }) => cat.displayName ?? cat.id,
  useCatData: () => ({ getCatById: (id: string) => ({ id, displayName: id, color: { primary: '#9B7EBD' } }) }),
}));
vi.mock('@/utils/api-client', () => ({ apiFetch: mocks.apiFetch }));

function setActive(catId: string, status: CatStatusType) {
  useChatStore.setState({
    currentThreadId: 'thread-a',
    activeInvocations: { 'inv-a': { catId, mode: 'execute', startedAt: 1000 } },
    hasActiveInvocation: true,
    intentMode: 'execute',
    targetCats: [catId],
    catStatuses: { [catId]: status },
    catInvocations: {},
    threadStates: {},
  });
}

describe('ThreadExecutionBar stop scope (#1307)', () => {
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
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it('offers a member X but no second whole-thread Stop', async () => {
    setActive('opus', 'streaming');
    act(() => {
      root.render(React.createElement(ThreadExecutionBar, { threadId: 'thread-a' }));
    });

    const stopCat = container.querySelector('[aria-label="停止 opus"]') as HTMLButtonElement;
    expect(stopCat).not.toBeNull();
    expect(container.querySelector('[data-testid="thread-stop-entry"]')).toBeNull();
    expect(container.textContent).not.toContain('停止对话');

    await act(async () => {
      stopCat.click();
    });
    expect(mocks.apiFetch).toHaveBeenCalledWith('/api/threads/thread-a/cancel/opus', { method: 'POST' });
  });

  it('keeps the same scope when a member is suspected stalled', () => {
    setActive('opus', 'suspected_stall');
    act(() => {
      root.render(React.createElement(ThreadExecutionBar, { threadId: 'thread-a' }));
    });

    expect(container.querySelector('[aria-label="停止 opus"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="thread-stop-entry"]')).toBeNull();
  });
});
