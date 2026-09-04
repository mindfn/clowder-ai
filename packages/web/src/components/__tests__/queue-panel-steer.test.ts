/**
 * F047: QueuePanel steer UI
 * - Steer button shows only for queued entries
 * - Steer modal offers interrupting restart and non-interrupting delivery
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueueEntry } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { QueuePanel } from '../QueuePanel';

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(async () => ({ ok: true, json: async () => ({}) })),
}));

const NOW = Date.now();

const QUEUED_ENTRY: QueueEntry = {
  id: 'q1',
  threadId: 'thread-1',
  userId: 'u1',
  content: 'queued message',
  messageId: 'm1',
  mergedMessageIds: [],
  from: { kind: 'user', userId: 'test-user' },
  targetCats: ['opus'],
  intent: 'execute',
  status: 'queued',
  createdAt: NOW,
};

const PROCESSING_ENTRY: QueueEntry = {
  ...QUEUED_ENTRY,
  id: 'q2',
  content: 'processing message',
  status: 'processing',
};

function response(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

describe('QueuePanel steer (F047)', () => {
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

    useChatStore.setState({
      messages: [],
      queue: [],
      currentThreadId: 'thread-1',
      activeInvocations: {},
      catInvocations: {},
      targetCats: [],
      threads: [
        {
          id: 'thread-1',
          projectPath: '/test',
          title: 'Test thread',
          createdBy: 'test-user',
          participants: ['opus', 'codex'],
          lastActiveAt: NOW,
          createdAt: NOW,
        },
      ],
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it('renders Steer only for queued entries', () => {
    useChatStore.setState({ queue: [QUEUED_ENTRY, PROCESSING_ENTRY] });
    act(() => {
      root.render(React.createElement(QueuePanel, { threadId: 'thread-1' }));
    });

    const html = container.innerHTML;
    expect(html).toContain('Steer');
    expect(container.querySelector('[data-testid="steer-q2"]')).toBeNull();
  });

  it('renders only actionable per-target queue truth hydrated from the server', () => {
    useChatStore.setState({
      queue: [
        {
          ...QUEUED_ENTRY,
          targetCats: ['opus', 'codex'],
          targetStates: { opus: 'seen', codex: 'failed', gpt52: 'handled' },
        },
      ],
    });
    act(() => {
      root.render(React.createElement(QueuePanel, { threadId: 'thread-1' }));
    });

    expect(container.textContent).toContain('已读，但关联回合已结束；尚未确认处理完成');
    expect(container.textContent).toContain('处理失败 · 已回队列');
    expect(container.textContent).not.toContain('已处理 · 无可回溯证据');
  });

  it('submits Steer as immediate cancel-and-restart without a promote choice', async () => {
    const { apiFetch } = await import('@/utils/api-client');
    useChatStore.setState({ queue: [QUEUED_ENTRY] });
    act(() => {
      root.render(React.createElement(QueuePanel, { threadId: 'thread-1' }));
    });

    const steerBtn = container.querySelector('[data-testid="steer-q1"]') as HTMLButtonElement | null;
    expect(steerBtn).not.toBeNull();
    act(() => steerBtn?.click());

    expect(container.querySelector('[data-testid="steer-mode-promote"]')).toBeNull();

    const confirm = container.querySelector('[data-testid="steer-confirm"]') as HTMLButtonElement | null;
    expect(confirm).not.toBeNull();

    await act(async () => {
      confirm?.click();
    });

    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(apiFetch).toHaveBeenCalledWith(
      '/api/threads/thread-1/queue/q1/steer',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetCatId: 'opus' }),
      }),
    );
  });

  it('lets a targetless queued message select an exact current-thread member', async () => {
    useChatStore.setState({ queue: [{ ...QUEUED_ENTRY, targetCats: [] }] });
    act(() => {
      root.render(React.createElement(QueuePanel, { threadId: 'thread-1' }));
    });

    act(() => container.querySelector<HTMLButtonElement>('[data-testid="steer-q1"]')?.click());
    expect(container.querySelector('[data-testid="steer-target-opus"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="steer-target-codex"]')).not.toBeNull();

    act(() => container.querySelector<HTMLButtonElement>('[data-testid="steer-target-codex"]')?.click());
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="steer-confirm"]')?.click());

    expect(apiFetch).toHaveBeenCalledWith('/api/threads/thread-1/queue/q1/steer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetCatId: 'codex' }),
    });
  });

  it('offers Append only from the server projection and echoes both exact fences', async () => {
    const appendEntry: QueueEntry = {
      ...QUEUED_ENTRY,
      lifecycleActions: {
        append: {
          kind: 'append',
          expectedQueueRevision: 'revision-1',
          expectedRuns: [{ targetId: 'opus', invocationId: 'turn-1', responseMessageId: 'response-1' }],
        },
      },
    };
    useChatStore.setState({ queue: [appendEntry] });
    act(() => {
      root.render(React.createElement(QueuePanel, { threadId: 'thread-1' }));
    });

    const append = container.querySelector('[data-testid="append-q1"]') as HTMLButtonElement | null;
    expect(append).not.toBeNull();
    await act(async () => append?.click());

    expect(apiFetch).toHaveBeenCalledWith('/api/threads/thread-1/queue/q1/append', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        expectedQueueRevision: 'revision-1',
        expectedRuns: [{ targetId: 'opus', invocationId: 'turn-1', responseMessageId: 'response-1' }],
      }),
    });
    expect(useChatStore.getState().queue).toEqual([]);
  });

  it('never infers Append from a local active invocation without a server action', () => {
    useChatStore.setState({
      queue: [QUEUED_ENTRY],
      activeInvocations: { 'turn-1': { catId: 'opus', mode: 'execute', startedAt: Date.now() } },
    });
    act(() => {
      root.render(React.createElement(QueuePanel, { threadId: 'thread-1' }));
    });
    expect(container.querySelector('[data-testid="append-q1"]')).toBeNull();
  });

  it('preserves a concurrent Queue arrival when an Append response resolves from an older render', async () => {
    const appendEntry: QueueEntry = {
      ...QUEUED_ENTRY,
      lifecycleActions: {
        append: {
          kind: 'append',
          expectedQueueRevision: 'revision-1',
          expectedRuns: [{ targetId: 'opus', invocationId: 'turn-1', responseMessageId: 'response-1' }],
        },
      },
    };
    const concurrentEntry: QueueEntry = { ...QUEUED_ENTRY, id: 'q-concurrent', content: 'arrived while appending' };
    let resolveAppend!: (value: Response) => void;
    vi.mocked(apiFetch).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveAppend = resolve;
        }),
    );
    useChatStore.setState({ queue: [appendEntry] });
    act(() => {
      root.render(React.createElement(QueuePanel, { threadId: 'thread-1' }));
    });

    const append = container.querySelector('[data-testid="append-q1"]') as HTMLButtonElement | null;
    await act(async () => {
      append?.click();
      await Promise.resolve();
    });
    act(() => useChatStore.getState().setQueue('thread-1', [appendEntry, concurrentEntry]));
    await act(async () => {
      resolveAppend(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
      await Promise.resolve();
    });

    expect(useChatStore.getState().queue).toEqual([concurrentEntry]);
  });

  it('closes a stale Steer confirmation and refreshes Queue truth after a 409', async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce(
        response({ code: 'ENTRY_PROCESSING', error: '条目正在处理中，无法 steer' }, 409) as Response,
      )
      .mockResolvedValueOnce(response({ queue: [], paused: false }) as Response);
    useChatStore.setState({ queue: [{ ...QUEUED_ENTRY, targetStates: { opus: 'queued' } }] });
    act(() => {
      root.render(React.createElement(QueuePanel, { threadId: 'thread-1' }));
    });

    act(() => container.querySelector<HTMLButtonElement>('[data-testid="steer-q1"]')?.click());
    const confirm = container.querySelector<HTMLButtonElement>('[data-testid="steer-confirm"]');
    expect(confirm).not.toBeNull();
    await act(async () => confirm?.click());

    expect(container.querySelector('[data-testid="steer-confirm"]')).toBeNull();
    expect(apiFetch).toHaveBeenCalledTimes(2);
    expect(apiFetch).toHaveBeenNthCalledWith(1, '/api/threads/thread-1/queue/q1/steer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetCatId: 'opus' }),
    });
    expect(apiFetch).toHaveBeenNthCalledWith(2, '/api/threads/thread-1/queue');
    expect(useChatStore.getState().queue).toEqual([]);
  });

  it('keeps Steer available for an ordinary pending target', () => {
    useChatStore.setState({ queue: [{ ...QUEUED_ENTRY, targetStates: { opus: 'queued' } }] });
    act(() => {
      root.render(React.createElement(QueuePanel, { threadId: 'thread-1' }));
    });

    expect(container.querySelector('[data-testid="steer-q1"]')).not.toBeNull();
  });

  it('offers both non-interrupting delivery and stop-then-restart for any selected member', async () => {
    useChatStore.setState({ queue: [QUEUED_ENTRY] });
    act(() => {
      root.render(React.createElement(QueuePanel, { threadId: 'thread-1' }));
    });

    const steerBtn = container.querySelector('[data-testid="steer-q1"]') as HTMLButtonElement | null;
    expect(steerBtn).not.toBeNull();
    act(() => steerBtn?.click());

    expect(container.textContent).toContain('opus');
    expect(container.querySelector('[data-testid="steer-append"]')?.textContent).toBe('立即发送，不停止');
    expect(container.querySelector('[data-testid="steer-confirm"]')?.textContent).toBe('停止回复并发送');
    expect(container.textContent).not.toContain('旧回复会被停止');
    expect(container.textContent).not.toContain('提到队首');

    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="steer-append"]')?.click());
    expect(apiFetch).toHaveBeenCalledWith('/api/threads/thread-1/queue/q1/continue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetCatId: 'opus' }),
    });
  });

  it('offers a non-interrupting reminder for an unread target with an active turn', async () => {
    useChatStore.setState({
      queue: [
        {
          ...QUEUED_ENTRY,
          targetStates: { opus: 'queued' },
          queueReceipt: {
            version: 1,
            entryId: 'q1',
            targets: [{ catId: 'opus', state: 'queued' }],
            reminderAttempts: [],
          },
        },
      ],
      activeInvocations: {
        'inv-active': { catId: 'opus', mode: 'execute', startedAt: Date.now() },
      },
      catInvocations: {
        opus: {
          invocationId: 'inv-active',
          freshnessCarrierCapability: {
            provider: 'openai_codex',
            carrier: 'codex_app_server',
            deliverySemantics: 'exact_active_turn',
          },
        },
      },
    });
    act(() => {
      root.render(React.createElement(QueuePanel, { threadId: 'thread-1' }));
    });

    const remind = container.querySelector('[data-testid="remind-q1-opus"]') as HTMLButtonElement | null;
    expect(remind).not.toBeNull();
    expect(remind?.textContent).toContain('提醒');

    await act(async () => remind?.click());

    expect(apiFetch).toHaveBeenCalledWith(
      '/api/threads/thread-1/queue/q1/remind',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ targetCatId: 'opus' }),
      }),
    );
  });

  it('shows the exact pending reminder state without offering a duplicate click', () => {
    useChatStore.setState({
      queue: [
        {
          ...QUEUED_ENTRY,
          targetStates: { opus: 'notified' },
          queueReceipt: {
            version: 1,
            entryId: 'q1',
            targets: [{ catId: 'opus', state: 'notified' }],
            reminderAttempts: [
              {
                id: 'reminder-1',
                targetCatId: 'opus',
                invocationId: 'inv-active',
                state: 'delivered',
                requestedAt: 1,
                deliveredAt: 2,
              },
            ],
          },
        },
      ],
      activeInvocations: {
        'inv-active': { catId: 'opus', mode: 'execute', startedAt: Date.now() },
      },
    });
    act(() => {
      root.render(React.createElement(QueuePanel, { threadId: 'thread-1' }));
    });

    expect(container.textContent).toContain('提醒已送达 · 尚未读取');
    expect(container.querySelector('[data-testid="remind-q1-opus"]')).toBeNull();
  });

  it('shows author disposition without opening the body and suppresses reminder on unsupported carriers', () => {
    useChatStore.setState({
      queue: [
        {
          ...QUEUED_ENTRY,
          targetStates: { opus: 'queued' },
          queueReceipt: {
            version: 1,
            entryId: 'q1',
            targets: [
              {
                catId: 'opus',
                state: 'queued',
                authorIntent: {
                  requested: 'next_work',
                  effective: 'next_work',
                  carrierCapability: {
                    provider: 'anthropic',
                    carrier: 'claude_print_sdk',
                    deliverySemantics: 'unsupported',
                  },
                },
              },
            ],
            reminderAttempts: [],
          },
        },
      ],
      activeInvocations: {
        'inv-active': { catId: 'opus', mode: 'execute', startedAt: Date.now() },
      },
      catInvocations: {
        opus: {
          invocationId: 'inv-active',
          freshnessCarrierCapability: {
            provider: 'anthropic',
            carrier: 'claude_print_sdk',
            deliverySemantics: 'unsupported',
          },
        },
      },
    });
    act(() => {
      root.render(React.createElement(QueuePanel, { threadId: 'thread-1' }));
    });

    expect(container.textContent).toContain('下一件工作');
    expect(container.textContent).toContain('当前接入不支持本轮读取/提醒');
    expect(container.querySelector('[data-testid="remind-q1-opus"]')).toBeNull();
  });
});
