import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@/stores/chat-types';
import { projectReplyHandoffs } from '../reply-handoff';

const reply = (id: string, catId = 'opus', invocationId = 'parent'): ChatMessage => ({
  id,
  type: 'assistant',
  catId,
  content: 'done',
  timestamp: 1,
  extra: { stream: { invocationId, turnInvocationId: `${invocationId}:turn` } },
});

const route = (
  id: string,
  over: Partial<NonNullable<NonNullable<ChatMessage['extra']>['a2aRouting']>> = {},
): ChatMessage => ({
  id,
  type: 'system',
  content: 'opus → codex-astra',
  timestamp: 2,
  extra: {
    systemKind: 'a2a_routing',
    a2aRouting: { fromCatId: 'opus', targetCatId: 'codex-astra', invocationId: 'parent', ...over },
  },
});

describe('F322 S3 reply-side a2a projection', () => {
  it('uses the exact source invocation and leaves the persisted carrier intact', () => {
    const carrier = route('route');
    const messages = [reply('wrong', 'opus', 'other'), reply('source'), carrier];
    const projected = projectReplyHandoffs(messages, () => true);

    expect(projected.renderByMessageId.get('source')).toEqual([
      { kind: 'handoff', targetCatIds: ['codex-astra'], sourceMessageIds: ['route'] },
    ]);
    expect(projected.hiddenRoutingMessageIds.has('route')).toBe(true);
    expect(carrier.extra?.a2aRouting?.targetCatId).toBe('codex-astra');
  });

  it('keeps an unbound route at its own position and presents a queued leg honestly', () => {
    const carrier = route('route', {
      fromCatId: 'sonnet',
      invocationId: 'missing',
      routing: { mode: 'serial', index: 2, total: 2 },
    });
    const projected = projectReplyHandoffs([reply('unrelated'), carrier], () => true);

    expect(projected.renderByMessageId.get('route')).toEqual([
      { kind: 'queued', targetCatIds: ['codex-astra'], sourceMessageIds: ['route'] },
    ]);
    expect(projected.hiddenRoutingMessageIds.has('route')).toBe(false);
  });

  it('groups only adjacent legs from the same real parallel batch', () => {
    const first = route('one', {
      invocationId: undefined,
      routing: { mode: 'parallel', index: 1, total: 2 },
    });
    first.content = 'opus ⇉ codex-astra（并行 1/2）';
    const second = route('two', {
      targetCatId: 'gemini',
      invocationId: undefined,
      routing: { mode: 'parallel', index: 2, total: 2 },
    });
    second.content = 'opus ⇉ gemini（并行 2/2）';
    const projected = projectReplyHandoffs([reply('source'), first, second], () => true);

    expect(projected.renderByMessageId.get('source')).toEqual([
      {
        kind: 'parallel',
        targetCatIds: ['codex-astra', 'gemini'],
        sourceMessageIds: ['one', 'two'],
      },
    ]);
    expect([...projected.hiddenRoutingMessageIds]).toEqual(['one', 'two']);
  });

  it('keeps a matched carrier standalone when the owner cannot render ReplyLayers', () => {
    const carrier = route('route');
    const projected = projectReplyHandoffs([reply('source'), carrier], () => false);

    expect(projected.renderByMessageId.get('source')).toBeUndefined();
    expect(projected.renderByMessageId.get('route')).toEqual([
      { kind: 'handoff', targetCatIds: ['codex-astra'], sourceMessageIds: ['route'] },
    ]);
    expect(projected.hiddenRoutingMessageIds.has('route')).toBe(false);
  });
});
