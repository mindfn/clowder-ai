/**
 * F117 Phase M (Landy …1294): an appended message is read when the cat's model read it. Until then it
 * waits in the Queue Panel as "等待读取 → cat" with no actions; once read it sits under the reply with
 * its read time; a run that ended first leaves it "未读取".
 */
import type { QueueAwaitingReadInput } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyAwaitingReadFromQueueResponse, useAwaitingReadStore } from '@/stores/awaitingReadStore';
import type { ChatMessage } from '@/stores/chat-types';
import { AppendedInputReceipts, projectUnreadAppendedInputs } from '../AppendedInputReceipts';
import { AwaitingReadRows } from '../AwaitingReadRows';
import { projectMessageDispatchAvatars } from '../MessageDispatchAvatars';

vi.mock('@/utils/focusLineageMessage', () => ({ focusLineageMessage: vi.fn() }));
vi.mock('../AvatarImageWithFallback', () => ({ AvatarImageWithFallback: () => <span data-testid="avatar" /> }));

Object.assign(globalThis as Record<string, unknown>, { React });

class MockResizeObserver implements ResizeObserver {
  disconnect() {}
  observe() {}
  unobserve() {}
}

const STARTED_AT = new Date(2026, 8, 26, 10, 0, 0).getTime();
const READ_AT = new Date(2026, 8, 26, 10, 0, 42).getTime();

function input(id: string, ref: Record<string, unknown>): ChatMessage {
  return {
    id,
    from: { kind: 'user', userId: 'co-creator' },
    type: 'user',
    content: `appended ${id}`,
    timestamp: STARTED_AT + 5_000,
    lifecycle: {
      kind: 'input',
      orderKey: `1:${id}`,
      dispatchRefs: [
        {
          targetId: 'opus',
          statusMessageId: 'response-1',
          dispatchedAt: STARTED_AT + 5_000,
          ...ref,
        } as never,
      ],
    },
  };
}

function response(
  status: 'processing' | 'completed' | 'canceled',
  lists: { inputMessageIds?: string[]; handedInputMessageIds?: string[] },
): ChatMessage {
  return {
    id: 'response-1',
    from: { kind: 'agent', catId: 'opus' },
    type: 'assistant',
    catId: 'opus',
    content: status === 'processing' ? '' : 'done',
    timestamp: STARTED_AT,
    lifecycle: {
      kind: 'response',
      orderKey: '1:response-1',
      invocationId: 'turn-1',
      targetId: 'opus',
      inputEntryIds: ['entry-initial', ...(lists.inputMessageIds ?? []).map((id) => `entry-${id}`)],
      inputMessageIds: ['source-initial', ...(lists.inputMessageIds ?? [])],
      ...(lists.handedInputMessageIds
        ? {
            handedInputEntryIds: lists.handedInputMessageIds.map((id) => `entry-${id}`),
            handedInputMessageIds: lists.handedInputMessageIds,
          }
        : {}),
      status,
      startedAt: STARTED_AT,
      ...(status === 'processing' ? {} : { completedAt: STARTED_AT + 60_000 }),
    },
  };
}

describe('F117 Phase M web projections', () => {
  it('projects an Append as unread only once its response ended', () => {
    const waiting = input('m-1', { phase: 'dispatched', readState: 'awaiting' });
    expect(projectUnreadAppendedInputs(response('processing', { handedInputMessageIds: ['m-1'] }), [waiting])).toEqual(
      [],
    );
    const unread = input('m-1', { phase: 'settled', readState: 'unread' });
    expect(projectUnreadAppendedInputs(response('canceled', { handedInputMessageIds: ['m-1'] }), [unread])).toEqual([
      unread,
    ]);
  });

  it('marks the dispatch avatar awaiting while the run can still read it, unread once it ended', () => {
    const waiting = input('m-1', { phase: 'dispatched', readState: 'awaiting' });
    expect(
      projectMessageDispatchAvatars(
        waiting,
        [waiting, response('processing', { handedInputMessageIds: ['m-1'] })],
        [],
      ).map((projection) => projection.phase),
    ).toEqual(['awaiting']);
    // The source may still carry its waiting ref after the response settled: the response decides.
    expect(
      projectMessageDispatchAvatars(
        waiting,
        [waiting, response('completed', { handedInputMessageIds: ['m-1'] })],
        [],
      ).map((projection) => projection.phase),
    ).toEqual(['unread']);
  });

  it('replaces the awaiting rows only from a /queue response that carries them', () => {
    const row: QueueAwaitingReadInput = {
      messageId: 'm-1',
      targetId: 'opus',
      responseMessageId: 'response-1',
      handedAt: STARTED_AT,
      from: { kind: 'user', userId: 'co-creator' },
      content: 'appended',
    };
    applyAwaitingReadFromQueueResponse('thread-1', { queue: [], awaitingRead: [row] });
    expect(useAwaitingReadStore.getState().rowsByThread['thread-1']).toEqual([row]);
    applyAwaitingReadFromQueueResponse('thread-1', { queue: [] });
    expect(useAwaitingReadStore.getState().rowsByThread['thread-1']).toEqual([row]);
    applyAwaitingReadFromQueueResponse('thread-1', { queue: [], awaitingRead: [] });
    expect(useAwaitingReadStore.getState().rowsByThread['thread-1']).toEqual([]);
  });
});

describe('F117 Phase M web rendering', () => {
  let container: HTMLDivElement;
  let root: Root;
  let originalResizeObserver: typeof globalThis.ResizeObserver;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    originalResizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = MockResizeObserver;
  });

  afterAll(() => {
    globalThis.ResizeObserver = originalResizeObserver;
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
  });

  it('shows a waiting row as 等待读取 → cat with nothing to act on', async () => {
    await act(async () => {
      root.render(
        <AwaitingReadRows
          rows={[
            {
              messageId: 'm-1',
              targetId: 'opus',
              responseMessageId: 'response-1',
              handedAt: STARTED_AT,
              from: { kind: 'user', userId: 'co-creator' },
              content: '顺便看一下那个测试',
            },
          ]}
          ownerName="Landy"
          resolveCatName={(catId) => (catId === 'opus' ? '宪宪' : catId)}
          resolveCatAvatar={() => undefined}
        />,
      );
    });
    const row = container.querySelector('[data-awaiting-read-message="m-1"]');
    expect(row?.textContent).toContain('等待读取 → 宪宪');
    expect(row?.textContent).toContain('顺便看一下那个测试');
    expect(row?.querySelectorAll('button')).toHaveLength(0);
  });

  it('lists a read Append with its read time and an unread one as 未读取 under the reply', async () => {
    const read = input('m-read', { phase: 'settled', readAt: READ_AT });
    const unread = input('m-unread', { phase: 'settled', readState: 'unread' });
    await act(async () => {
      root.render(
        <AppendedInputReceipts
          response={response('canceled', { inputMessageIds: ['m-read'], handedInputMessageIds: ['m-unread'] })}
          timelineMessages={[read, unread]}
          coCreatorName="Landy"
          getCatLabel={(catId) => catId}
        />,
      );
    });
    const readRow = container.querySelector('[data-appended-input-id="m-read"]');
    expect(readRow?.querySelector('[data-appended-input-read="read"]')?.textContent).toBe('读取于 09/26 10:00:42');
    const unreadRow = container.querySelector('[data-appended-input-id="m-unread"]');
    expect(unreadRow?.querySelector('[data-appended-input-read="unread"]')?.textContent).toBe('未读取');
  });
});
