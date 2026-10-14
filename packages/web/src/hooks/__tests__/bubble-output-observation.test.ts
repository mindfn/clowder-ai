import { createHash } from 'node:crypto';
import type { MessageOutputLayoutV1 } from '@cat-cafe/shared';
import { describe, expect, it } from 'vitest';
import { adaptIncomingToBubbleEvent } from '@/hooks/bubble-event-adapter';
import type { BackgroundAgentMessage } from '@/hooks/useAgentMessages';
import { applyBubbleEvent, type BubbleEvent } from '@/stores/bubble-reducer';
import type { ChatMessage } from '@/stores/chat-types';

function layout(content: string): MessageOutputLayoutV1 {
  return {
    v: 1,
    owner: { threadId: 'thread-one', catId: 'codex61-sol', turnInvocationId: 'turn-inv' },
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
}
function text(
  content: string,
  outputLayout?: MessageOutputLayoutV1,
): BackgroundAgentMessage & { extra?: { outputLayout?: MessageOutputLayoutV1 } } {
  return {
    type: 'text',
    catId: 'codex61-sol',
    threadId: 'thread-one',
    invocationId: 'parent-inv',
    turnInvocationId: 'turn-inv',
    timestamp: 1000,
    content,
    textMode: 'replace',
    ...(outputLayout ? { extra: { outputLayout } } : {}),
  };
}
function apply(messages: ChatMessage[], event: BubbleEvent | undefined): ChatMessage[] {
  if (!event) throw new Error('Expected dispatched bubble event');
  return applyBubbleEvent({ threadId: 'thread-one', currentMessages: messages, event }).nextMessages;
}

describe('Studio526 API full-content/layout snapshots at the one bubble ingress', () => {
  for (const sourcePath of ['active', 'background'] as const) {
    it(`${sourcePath}: forwards the message-owned layout and true visible child`, () => {
      const outputLayout = layout('回答。');
      const event = adaptIncomingToBubbleEvent(text('回答。', outputLayout), { sourcePath });
      expect(event?.canonicalInvocationId).toBe('turn-inv');
      expect(event?.payload?.extra).toMatchObject({ outputLayout });
      const messages = apply([], event);
      expect(messages[0]?.extra?.outputLayout).toEqual(outputLayout);
    });
    it(`${sourcePath}: native replacement is already a complete API snapshot, not another client accumulator`, () => {
      let messages = apply([], adaptIncomingToBubbleEvent(text('过程。'), { sourcePath }));
      const snapshot = text('过程。\n\n回答。', layout('过程。\n\n回答。'));
      messages = apply(messages, adaptIncomingToBubbleEvent(snapshot, { sourcePath }));
      messages = apply(messages, adaptIncomingToBubbleEvent(snapshot, { sourcePath }));
      expect(messages[0]?.content).toBe('过程。\n\n回答。');
      expect(messages[0]?.extra?.outputLayout).toEqual(snapshot.extra?.outputLayout);
    });
    it(`${sourcePath}: a legacy replacement cannot inherit a previous layout`, () => {
      let messages = apply([], adaptIncomingToBubbleEvent(text('回答。', layout('回答。')), { sourcePath }));
      messages = apply(messages, adaptIncomingToBubbleEvent(text('new canonical body'), { sourcePath }));
      expect(messages[0]?.content).toBe('new canonical body');
      expect(messages[0]?.extra?.outputLayout).toBeUndefined();
    });
  }
  it('an explicit callback cannot adopt a native-only layout or invocation identity', () => {
    const event = adaptIncomingToBubbleEvent(
      {
        ...text('独立回话。', layout('独立回话。')),
        origin: 'callback',
        extra: { outputLayout: layout('独立回话。'), isExplicitPost: true },
      },
      { sourcePath: 'callback' },
    );
    expect(event?.canonicalInvocationId).toBeUndefined();
    expect((event?.payload?.extra as ChatMessage['extra'])?.outputLayout).toBeUndefined();
  });
  it('callback final replacement clears the old native-only layout and keeps callback content', () => {
    let messages = apply([], adaptIncomingToBubbleEvent(text('回答。', layout('回答。')), { sourcePath: 'active' }));
    messages = apply(
      messages,
      adaptIncomingToBubbleEvent(
        { ...text('callback canonical body'), origin: 'callback', messageId: 'stored-final' },
        { sourcePath: 'callback' },
      ),
    );
    const callback = messages.find((message) => message.origin === 'callback');
    expect(callback?.content).toBe('callback canonical body');
    expect(callback?.extra?.outputLayout).toBeUndefined();
  });
});
