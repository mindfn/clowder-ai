import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@/stores/chat-types';
import { apiFetch } from '@/utils/api-client';
import { FailedResponseRetry } from '../FailedResponseRetry';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));

const source: ChatMessage = {
  id: 'source-1',
  from: { kind: 'user', userId: 'user-1' },
  type: 'user',
  content: 'please handle this',
  timestamp: 100,
  extra: {
    queueReceipt: {
      version: 1,
      entryId: 'entry-1',
      targets: [
        {
          catId: 'opus',
          state: 'failed',
          attempts: [
            {
              id: 'entry-1:opus:2',
              targetCatId: 'opus',
              sequence: 2,
              state: 'failed',
              createdAt: 100,
              updatedAt: 200,
              terminalReason: 'invocation_failed',
            },
          ],
        },
      ],
      reminderAttempts: [],
    },
  },
};

function response(status: 'completed' | 'failed' | 'canceled' | 'interrupted'): ChatMessage {
  return {
    id: 'response-1',
    from: { kind: 'agent', catId: 'opus' },
    type: 'assistant',
    catId: 'opus',
    content: status === 'failed' ? '处理失败' : 'terminal',
    timestamp: 200,
    replyTo: source.id,
    lifecycle: {
      kind: 'response',
      orderKey: '200:turn-1',
      invocationId: 'turn-1',
      targetId: 'opus',
      inputEntryIds: ['entry-1'],
      inputMessageIds: [source.id],
      status,
      startedAt: 150,
      completedAt: 200,
    },
  };
}

describe('FailedResponseRetry', () => {
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
    vi.mocked(apiFetch).mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it.each(['completed', 'canceled', 'interrupted'] as const)('does not offer retry for %s', (status) => {
    act(() => root.render(<FailedResponseRetry message={response(status)} timelineMessages={[source]} />));
    expect(container.querySelector('[data-testid="failed-response-retry"]')).toBeNull();
  });

  it('fails closed when the failed response has no exact reply lineage', () => {
    const failed = { ...response('failed'), replyTo: undefined };
    act(() => root.render(<FailedResponseRetry message={failed} timelineMessages={[source]} />));
    expect(container.querySelector('[data-testid="failed-response-retry"]')).toBeNull();
  });

  it('retries the exact source target and latest failed attempt from the failed terminal bubble', async () => {
    vi.mocked(apiFetch).mockResolvedValue(new Response(JSON.stringify({ status: 'retry_queued' }), { status: 202 }));
    act(() => root.render(<FailedResponseRetry message={response('failed')} timelineMessages={[source]} />));

    const retry = container.querySelector<HTMLButtonElement>('[data-testid="failed-response-retry"]');
    expect(retry).not.toBeNull();
    await act(async () => retry?.click());

    expect(apiFetch).toHaveBeenCalledWith('/api/messages/source-1/queue-targets/opus/retry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ attemptId: 'entry-1:opus:2' }),
    });
    expect(retry?.disabled).toBe(true);
    expect(retry?.textContent).toBe('已提交');
  });
});
