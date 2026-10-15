import { describe, expect, it } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import type { ChatMessage } from '@/stores/chat-types';
import { canRenderReplyLayers, canRenderReplyNameplate } from '../reply-presentation';

const knownCat = { id: 'opus' } as CatData;
const visibleReply: ChatMessage = {
  id: 'reply',
  type: 'assistant',
  catId: 'opus',
  content: 'done',
  timestamp: 1,
};
const context = {
  shellPresentation: 'v2' as const,
  compact: false,
  getCatById: (catId: string) => (catId === 'opus' ? knownCat : undefined),
};

describe('F322 ReplyLayers presentation eligibility', () => {
  it('requires a thread for ReplyLayers even though the same visible reply can still draw a nameplate', () => {
    expect(canRenderReplyNameplate(visibleReply, context)).toBe(true);
    expect(canRenderReplyLayers(visibleReply, context)).toBe(false);
    expect(canRenderReplyLayers(visibleReply, { ...context, currentThreadId: 'thread-1' })).toBe(true);
  });

  it('uses canonical bubble renderability instead of treating identity metadata as a visible reply', () => {
    const identityOnly = { ...visibleReply, content: '' };

    expect(canRenderReplyNameplate(identityOnly, context)).toBe(false);
    expect(canRenderReplyLayers(identityOnly, { ...context, currentThreadId: 'thread-1' })).toBe(false);
  });

  it('preserves the trusted legacy user-plus-cat author path', () => {
    const legacy = { ...visibleReply, type: 'user' as const };

    expect(canRenderReplyNameplate(legacy, context)).toBe(true);
    expect(canRenderReplyLayers(legacy, { ...context, currentThreadId: 'thread-1' })).toBe(true);
  });
});
