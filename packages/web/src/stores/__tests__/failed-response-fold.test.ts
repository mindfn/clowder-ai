import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../chat-types';
import { foldFailedResponseRetries } from '../failed-response-fold';

describe('failed response retries fold into the final failure', () => {
  it('folds an exact failed frontier chain into the final source-bound response bubble', () => {
    const source: ChatMessage = {
      id: 'source-1',
      type: 'user',
      content: '@狸花猫 test',
      timestamp: 100,
      lifecycle: {
        kind: 'input',
        orderKey: '100:source-1',
        dispatchRefs: [{ targetId: 'tabby', phase: 'settled', statusMessageId: 'final-failure', dispatchedAt: 1_000 }],
      },
    };
    const auxiliaryFailure: ChatMessage = {
      id: 'aux-failure',
      type: 'assistant',
      catId: 'tabby',
      content: 'Error: first attempt',
      timestamp: 110,
      origin: 'stream',
      extra: {
        stream: { turnInvocationId: 'attempt-1' },
        freshness: { priorFrontierMessageId: source.id },
      },
      lifecycle: {
        kind: 'response',
        orderKey: '110:attempt-1',
        invocationId: 'attempt-1',
        targetId: 'tabby',
        inputEntryIds: ['aux-entry'],
        inputMessageIds: [],
        startedAt: 110,
        status: 'failed',
        completedAt: 115,
        reason: 'PROVIDER_EXECUTION_FAILED',
      },
    };
    const finalFailure: ChatMessage = {
      id: 'final-failure',
      type: 'assistant',
      catId: 'tabby',
      replyTo: source.id,
      content: 'Error: final attempt',
      timestamp: 120,
      origin: 'stream',
      extra: {
        stream: { turnInvocationId: 'attempt-2' },
        freshness: { priorFrontierMessageId: auxiliaryFailure.id },
      },
      lifecycle: {
        kind: 'response',
        orderKey: '120:attempt-2',
        invocationId: 'attempt-2',
        targetId: 'tabby',
        inputEntryIds: ['source-entry'],
        inputMessageIds: [source.id],
        startedAt: 120,
        status: 'failed',
        completedAt: 125,
        reason: 'PROVIDER_EXECUTION_FAILED',
      },
    };

    const messages = foldFailedResponseRetries([source, auxiliaryFailure, finalFailure]);

    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({
      id: finalFailure.id,
      replyTo: source.id,
      content: 'Error: first attempt\n\nError: final attempt',
      lifecycle: finalFailure.lifecycle,
      projectionSourceMessageIds: [auxiliaryFailure.id, finalFailure.id],
    });
  });

  it('does not fold a prior failed response without the exact final source/ref/frontier chain', () => {
    const source: ChatMessage = { id: 'source-1', type: 'user', content: 'test', timestamp: 100 };
    const first: ChatMessage = {
      id: 'failure-1',
      type: 'assistant',
      catId: 'tabby',
      content: 'Error: unrelated',
      timestamp: 110,
      extra: { stream: { turnInvocationId: 'attempt-1' } },
      lifecycle: {
        kind: 'response',
        orderKey: '110:attempt-1',
        invocationId: 'attempt-1',
        targetId: 'tabby',
        inputEntryIds: ['entry-1'],
        inputMessageIds: [],
        startedAt: 110,
        status: 'failed',
        completedAt: 111,
      },
    };
    const second: ChatMessage = {
      ...first,
      id: 'failure-2',
      timestamp: 120,
      content: 'Error: final',
      extra: { stream: { turnInvocationId: 'attempt-2' } },
      lifecycle: {
        ...first.lifecycle!,
        orderKey: '120:attempt-2',
        invocationId: 'attempt-2',
      } as ChatMessage['lifecycle'],
    };

    expect(foldFailedResponseRetries([source, first, second])).toHaveLength(3);
  });
});
