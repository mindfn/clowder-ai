import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatStatusType } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { ThreadExecutionBar } from '../ThreadExecutionBar';

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(async () => new Response('{"ok":true,"cancelled":true}', { status: 200 })),
  addToast: vi.fn(),
}));

vi.mock('@/hooks/useCatData', () => ({
  formatCatName: (cat: { displayName?: string; id: string }) => cat.displayName ?? cat.id,
  useCatData: () => ({ getCatById: (id: string) => ({ id, displayName: id, color: { primary: '#9B7EBD' } }) }),
}));
vi.mock('@/utils/api-client', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('@/stores/toastStore', () => ({
  useToastStore: { getState: () => ({ addToast: mocks.addToast }) },
}));

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

  it('reports a non-OK member Stop response', async () => {
    mocks.apiFetch.mockResolvedValueOnce(new Response('{"error":"not active"}', { status: 404 }));
    setActive('opus', 'streaming');
    act(() => {
      root.render(React.createElement(ThreadExecutionBar, { threadId: 'thread-a' }));
    });

    const stopCat = container.querySelector('[aria-label="停止 opus"]') as HTMLButtonElement;
    await act(async () => {
      stopCat.click();
    });

    expect(mocks.apiFetch).toHaveBeenCalledWith('/api/threads/thread-a/cancel/opus', { method: 'POST' });
    expect(mocks.addToast).toHaveBeenCalledWith({
      type: 'error',
      title: '停止失败',
      message: '未能停止该成员的运行，请稍后重试。',
      duration: 5000,
    });
  });

  it('contains a rejected member Stop request and reports it to the user', async () => {
    mocks.apiFetch.mockRejectedValueOnce(new Error('network unavailable'));
    setActive('opus', 'streaming');
    act(() => {
      root.render(React.createElement(ThreadExecutionBar, { threadId: 'thread-a' }));
    });

    const stopCat = container.querySelector('[aria-label="停止 opus"]') as HTMLButtonElement;
    await act(async () => {
      stopCat.click();
    });

    expect(mocks.addToast).toHaveBeenCalledWith({
      type: 'error',
      title: '停止失败',
      message: '未能停止该成员的运行，请稍后重试。',
      duration: 5000,
    });
  });
});
