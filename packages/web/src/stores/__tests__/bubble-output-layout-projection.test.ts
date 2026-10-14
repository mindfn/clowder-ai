import { createHash } from 'node:crypto';
import type { MessageOutputLayoutV1 } from '@cat-cafe/shared';
import { describe, expect, it } from 'vitest';
import { projectCanonicalBubbles } from '../bubble-projection';
import type { ChatMessage } from '../chat-types';

function record(id: string, content: string, child = 'child'): ChatMessage {
  const outputLayout: MessageOutputLayoutV1 = {
    v: 1,
    owner: { threadId: 'thread', catId: 'codex61-sol', turnInvocationId: child },
    contentRevision: { length: content.length, sha256: createHash('sha256').update(content).digest('hex') },
    status: 'available',
    runs: [
      {
        id: 'final',
        identity: { provider: 'codex', runtimeSessionId: 'native', turnId: 'native-turn', nativeId: 'final' },
        channel: 'final',
        complete: true,
        start: 0,
        end: content.length,
        gluePrefixLength: 0,
      },
    ],
    order: [{ kind: 'run', runId: 'final' }],
  };
  return {
    id,
    type: 'assistant',
    catId: 'codex61-sol',
    content,
    timestamp: 1,
    origin: 'stream',
    extra: { stream: { invocationId: 'parent', turnInvocationId: child }, outputLayout },
  };
}
const project = (records: ChatMessage[]) => projectCanonicalBubbles({ records }).messages;

describe('message-owned layout at raw-record/canonical composition', () => {
  it('retains the exact one-body native record', () => {
    const input = record('stored', 'answer');
    expect(project([input])[0].extra?.outputLayout).toEqual(input.extra?.outputLayout);
  });
  it('does not spread one raw record layout onto a differently composed full body', () => {
    const a = record('a', 'first');
    const b = { ...record('b', 'second'), timestamp: 2 };
    const result = project([a, b])[0];
    expect(result.content).toBe('first\n\nsecond');
    expect(result.extra?.outputLayout?.status).not.toBe('available');
  });
  it('does not classify a callback, even if it received native-only metadata', () => {
    const input = {
      ...record('callback', 'speech'),
      origin: 'callback' as const,
      extra: { ...record('callback', 'speech').extra, isExplicitPost: true },
    };
    expect(project([input])[0].extra?.outputLayout?.status).not.toBe('available');
  });
  it('rejects a layout belonging to a different visible child', () => {
    const input = record('stored', 'answer');
    if (!input.extra?.outputLayout) throw new Error('fixture');
    input.extra.outputLayout.owner.turnInvocationId = 'other-child';
    expect(project([input])[0].extra?.outputLayout?.status).not.toBe('available');
  });
  it('keeps same-parent same-cat children separate', () => {
    const result = project([record('a', 'first', 'child-a'), record('b', 'second', 'child-b')]);
    expect(result).toHaveLength(2);
    expect(result.map((message) => message.extra?.outputLayout?.owner.turnInvocationId)).toEqual([
      'child-a',
      'child-b',
    ]);
  });
});
