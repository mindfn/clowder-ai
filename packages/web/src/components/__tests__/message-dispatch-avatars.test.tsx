import type { LifecycleActiveRun } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@/stores/chat-types';
import {
  isLinkedDeliveryFailureCarrier,
  MessageDispatchAvatars,
  projectMessageDispatchAvatars,
} from '../MessageDispatchAvatars';

vi.mock('../CatAvatar', () => ({
  CatAvatar: ({ catId, status }: { catId: string; status?: string }) => (
    <span data-testid="cat-avatar" data-cat-id={catId} data-status={status} />
  ),
}));

const source = (phase: 'assigned' | 'dispatched' | 'settled', statusMessageId = 'response-1'): ChatMessage => ({
  id: 'source-1',
  from: { kind: 'external', connectorId: 'github' },
  type: 'connector',
  content: 'PR changed',
  timestamp: 100,
  lifecycle: {
    kind: 'input',
    orderKey: '100:source-1',
    dispatchRefs: phase === 'assigned' ? [{ targetId: 'opus', phase }] : [{ targetId: 'opus', phase, statusMessageId }],
  },
});

const response = (
  status: 'processing' | 'completed' | 'failed' | 'canceled' | 'interrupted',
  inputMessageIds: readonly string[] = ['source-1'],
): ChatMessage => ({
  id: 'response-1',
  from: { kind: 'agent', catId: 'opus' },
  type: 'assistant',
  catId: 'opus',
  content: status === 'processing' ? '' : 'terminal',
  timestamp: 110,
  lifecycle: {
    kind: 'response',
    orderKey: '110:turn-1',
    invocationId: 'turn-1',
    targetId: 'opus',
    inputEntryIds: ['entry-1'],
    inputMessageIds,
    status,
    startedAt: 110,
    ...(status === 'processing' ? {} : { completedAt: 120 }),
  },
});

const activeRun: LifecycleActiveRun = {
  threadId: 'thread-1',
  targetId: 'opus',
  invocationId: 'turn-1',
  responseMessageId: 'response-1',
  inputEntryIds: ['entry-1'],
  inputMessageIds: ['source-1'],
  privateInputEntryIds: [],
  startedAt: 110,
};

describe('projectMessageDispatchAvatars', () => {
  it('renders no avatar for assigned work or incomplete active-run evidence', () => {
    expect(projectMessageDispatchAvatars(source('assigned'), [source('assigned')], [activeRun])).toEqual([]);
    expect(projectMessageDispatchAvatars(source('dispatched'), [response('processing')], [])).toEqual([]);
    expect(
      projectMessageDispatchAvatars(
        source('dispatched'),
        [response('processing')],
        [{ ...activeRun, responseMessageId: 'another-response' }],
      ),
    ).toEqual([]);
  });

  it('blinks only for the exact dispatched response and exact ActiveRun', () => {
    expect(projectMessageDispatchAvatars(source('dispatched'), [response('processing')], [activeRun])).toEqual([
      { targetId: 'opus', phase: 'processing', statusMessageId: 'response-1' },
    ]);
  });

  it.each([
    ['user', { from: { kind: 'user', userId: 'user-1' }, type: 'user', catId: undefined }],
    ['cat', { from: { kind: 'agent', catId: 'codex' }, type: 'assistant', catId: 'codex' }],
    ['IM connector', { from: { kind: 'external', connectorId: 'weixin' }, type: 'connector', catId: undefined }],
    ['GitHub notice', { from: { kind: 'external', connectorId: 'github' }, type: 'connector', catId: undefined }],
    ['system row', { from: { kind: 'system', service: 'scheduler' }, type: 'system', catId: undefined }],
  ] as const)('uses the same exact lifecycle projection for a %s source', (_label, identity) => {
    const candidate: ChatMessage = {
      ...source('settled'),
      ...identity,
    } as ChatMessage;
    expect(projectMessageDispatchAvatars(candidate, [response('completed')], [])).toEqual([
      { targetId: 'opus', phase: 'settled', statusMessageId: 'response-1' },
    ]);
  });

  it.each([
    'completed',
    'failed',
    'canceled',
    'interrupted',
  ] as const)('keeps one outcome-neutral static avatar for a %s terminal response', (status) => {
    expect(projectMessageDispatchAvatars(source('settled'), [response(status)], [])).toEqual([
      { targetId: 'opus', phase: 'settled', statusMessageId: 'response-1' },
    ]);
  });

  it('projects a linked pre-admission failure as static without inventing a response', () => {
    const failure: ChatMessage = {
      id: 'failure-1',
      from: { kind: 'system', service: 'message_delivery' },
      type: 'system',
      content: '唤起 opus 失败',
      timestamp: 120,
      lifecycle: {
        kind: 'delivery_failure',
        orderKey: '120:failure-1',
        status: 'failed',
        sourceEntryId: 'entry-1',
        inputMessageId: 'source-1',
        requestedTargets: ['opus'],
        reason: 'invalid_explicit_target',
        createdAt: 120,
      },
    };
    expect(projectMessageDispatchAvatars(source('settled', failure.id), [failure], [])).toEqual([
      { targetId: 'opus', phase: 'settled', statusMessageId: failure.id },
    ]);
  });

  it('fails closed on target, source, status-message, or duplicate-target ambiguity', () => {
    const wrongTarget = response('completed');
    if (wrongTarget.lifecycle?.kind !== 'response') throw new Error('fixture lost response lifecycle');
    wrongTarget.lifecycle = { ...wrongTarget.lifecycle, targetId: 'codex' };
    expect(projectMessageDispatchAvatars(source('settled'), [wrongTarget], [])).toEqual([]);
    expect(projectMessageDispatchAvatars(source('settled'), [response('completed', ['another-source'])], [])).toEqual(
      [],
    );

    const duplicate = source('settled');
    if (!duplicate.lifecycle) throw new Error('fixture lost lifecycle');
    duplicate.lifecycle = {
      ...duplicate.lifecycle,
      dispatchRefs: [
        { targetId: 'opus', phase: 'settled', statusMessageId: 'response-1' },
        { targetId: 'opus', phase: 'settled', statusMessageId: 'response-2' },
      ],
    };
    expect(projectMessageDispatchAvatars(duplicate, [response('completed')], [])).toEqual([]);
  });
});

describe('isLinkedDeliveryFailureCarrier', () => {
  const failure = (requestedTargets: string[]): ChatMessage => ({
    id: 'failure-1',
    from: { kind: 'system', service: 'message-delivery' },
    type: 'system',
    content: '唤起处理成员失败',
    timestamp: 120,
    lifecycle: {
      kind: 'delivery_failure',
      orderKey: '120:failure-1',
      status: 'failed',
      sourceEntryId: 'entry-1',
      inputMessageId: 'source-1',
      requestedTargets,
      reason: 'no_available_target',
      createdAt: 120,
    },
  });

  const agentSource = (): ChatMessage => ({
    ...source('settled', 'failure-1'),
    from: { kind: 'agent', catId: 'codex' },
    type: 'assistant',
    catId: 'codex',
  });

  it('absorbs only a failure with exact settled source refs for every requested target', () => {
    expect(isLinkedDeliveryFailureCarrier(failure(['opus']), [agentSource()])).toBe(true);
    expect(isLinkedDeliveryFailureCarrier(failure(['opus']), [source('assigned')])).toBe(false);
  });

  it('keeps an origin failure visible even when its source avatar has settled', () => {
    expect(isLinkedDeliveryFailureCarrier(failure(['opus']), [source('settled', 'failure-1')])).toBe(false);
  });

  it('never absorbs a targetless origin failure by vacuous truth', () => {
    expect(isLinkedDeliveryFailureCarrier(failure([]), [agentSource()])).toBe(false);
  });
});

describe('MessageDispatchAvatars', () => {
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
  });

  it('uses animation only for processing and adds no terminal outcome badge', () => {
    act(() => {
      root.render(
        <MessageDispatchAvatars
          message={source('settled')}
          timelineMessages={[response('failed')]}
          activeRuns={[]}
          getCatLabel={() => '布偶猫'}
        />,
      );
    });
    const avatar = container.querySelector('[data-testid="cat-avatar"]');
    expect(avatar?.getAttribute('data-status')).toBeNull();
    expect(container.textContent).toBe('');
    expect(container.querySelector('[data-dispatch-outcome]')).toBeNull();

    act(() => {
      root.render(
        <MessageDispatchAvatars
          message={source('dispatched')}
          timelineMessages={[response('processing')]}
          activeRuns={[activeRun]}
          getCatLabel={() => '布偶猫'}
        />,
      );
    });
    expect(container.querySelector('[data-testid="cat-avatar"]')?.getAttribute('data-status')).toBe('streaming');
  });
});
