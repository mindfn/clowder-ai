import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { InteractiveBlock } from '@/components/rich/InteractiveBlock';
import type { RichInteractiveBlock } from '@/stores/chat-types';

const apiFetchMock = vi.fn();

vi.mock('@/stores/chatStore', () => ({
  useChatStore: { getState: () => ({ updateRichBlock: vi.fn() }) },
}));

vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

vi.mock('@/utils/userId', () => ({
  getUserId: () => 'test-user',
}));

describe('InteractiveBlock direct callback actions', () => {
  let container: HTMLDivElement;
  let root: Root;
  let receivedGuideStart: string | null;
  const block: RichInteractiveBlock = {
    id: 'guide-offer',
    kind: 'interactive',
    v: 1,
    interactiveType: 'select',
    title: '开始引导吗？',
    options: [
      {
        id: 'start',
        label: '开始引导',
        action: {
          type: 'callback',
          endpoint: '/api/guide-actions/start',
          payload: { threadId: 'thread-1', guideId: 'add-member' },
        },
      },
    ],
  };

  const onGuideStart = (e: Event) => {
    receivedGuideStart = (e as CustomEvent<{ flowId: string }>).detail.flowId;
  };

  beforeAll(() => {
    (globalThis as Record<string, unknown>).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as Record<string, unknown>).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    receivedGuideStart = null;
    apiFetchMock.mockReset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    window.addEventListener('guide:start', onGuideStart);
  });

  afterEach(() => {
    window.removeEventListener('guide:start', onGuideStart);
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('does not dispatch guide:start when callback endpoint fails', async () => {
    apiFetchMock.mockResolvedValue({ ok: false, status: 500 });

    await act(async () => {
      root.render(React.createElement(InteractiveBlock, { block, messageId: 'message-1' }));
    });

    const optionBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('开始引导'));
    expect(optionBtn).toBeTruthy();
    await act(async () => {
      optionBtn!.click();
    });

    const confirmBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('确认选择'),
    );
    expect(confirmBtn).toBeTruthy();
    await act(async () => {
      confirmBtn!.click();
      await Promise.resolve();
    });

    expect(apiFetchMock).toHaveBeenCalledWith('/api/guide-actions/start', expect.objectContaining({ method: 'POST' }));
    expect(receivedGuideStart).toBeNull();
  });

  it('rejects callback actions outside the safe guide-actions allowlist', async () => {
    const unsafeBlock: RichInteractiveBlock = {
      ...block,
      id: 'unsafe-guide-offer',
      options: [
        {
          id: 'unsafe-start',
          label: '危险操作',
          action: {
            type: 'callback',
            endpoint: '/api/admin/delete-all',
            payload: { threadId: 'thread-1', guideId: 'add-member' },
          },
        },
      ],
    };

    await act(async () => {
      root.render(React.createElement(InteractiveBlock, { block: unsafeBlock, messageId: 'message-2' }));
    });

    const optionBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('危险操作'));
    expect(optionBtn).toBeTruthy();
    await act(async () => {
      optionBtn!.click();
    });

    const confirmBtn = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('确认选择'),
    );
    expect(confirmBtn).toBeTruthy();
    await act(async () => {
      confirmBtn!.click();
      await Promise.resolve();
    });

    expect(apiFetchMock).not.toHaveBeenCalled();
    expect(receivedGuideStart).toBeNull();
  });
});
