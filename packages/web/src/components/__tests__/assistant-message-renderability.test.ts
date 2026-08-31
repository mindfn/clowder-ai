import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@/stores/chat-types';
import { doesAssistantMessageRenderBubble } from '../assistant-message-renderability';

function response(status: 'processing' | 'completed' | 'failed', content = ''): ChatMessage {
  return {
    id: 'response-1',
    type: 'assistant',
    catId: 'opus',
    content,
    timestamp: 100,
    isStreaming: status === 'processing',
    extra: {
      turnExecution: {
        invocationId: 'turn-1',
        parentInvocationId: 'parent-1',
        executionKind: 'ordinary',
      },
    },
    lifecycle: {
      kind: 'response',
      orderKey: '100:turn-1',
      invocationId: 'turn-1',
      targetId: 'opus',
      inputEntryIds: ['entry-1'],
      inputMessageIds: ['source-1'],
      status,
      startedAt: 100,
      ...(status === 'processing' ? {} : { completedAt: 120 }),
    },
  };
}

describe('doesAssistantMessageRenderBubble', () => {
  it('does not let streaming or execution metadata create a processing air bubble', () => {
    expect(doesAssistantMessageRenderBubble(response('processing'))).toBe(false);
  });

  it('allows a processing response only after real partial content exists', () => {
    expect(doesAssistantMessageRenderBubble(response('processing', 'partial'))).toBe(true);
  });

  it.each(['completed', 'failed'] as const)('keeps one terminal %s response bubble even without body', (status) => {
    expect(doesAssistantMessageRenderBubble(response(status))).toBe(true);
  });
});
