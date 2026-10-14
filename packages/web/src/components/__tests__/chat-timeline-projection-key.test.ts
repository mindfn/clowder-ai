import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@/stores/chat-types';
import { buildChatTimelineProjectionKey } from '../chat-timeline-projection-key';

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'assistant-1',
    type: 'assistant',
    catId: 'codex-sol',
    content: 'working',
    timestamp: 1,
    isStreaming: true,
    extra: {
      turnExecution: { invocationId: 'inv-1', parentInvocationId: 'parent-1', executionKind: 'ordinary' },
    },
    ...overrides,
  };
}

describe('buildChatTimelineProjectionKey', () => {
  it('ignores assistant stream content and tool deltas that cannot change cross-message projections', () => {
    const before = message();
    const after = message({
      content: 'working with another streamed token',
      toolEvents: [{ id: 'tool-1', type: 'tool_result', label: 'result', detail: 'large result', timestamp: 2 }],
    });

    expect(buildChatTimelineProjectionKey([after])).toBe(buildChatTimelineProjectionKey([before]));
  });

  it('changes when terminal or receipt topology changes', () => {
    const streaming = message();
    const terminal = message({ isStreaming: false });
    const receipt = message({
      type: 'user',
      catId: undefined,
      extra: {
        queueReceipt: {
          version: 1,
          entryId: 'entry-1',
          targets: [],
          reminderAttempts: [],
        },
      },
    });

    expect(buildChatTimelineProjectionKey([terminal])).not.toBe(buildChatTimelineProjectionKey([streaming]));
    expect(buildChatTimelineProjectionKey([receipt])).not.toBe(buildChatTimelineProjectionKey([streaming]));
  });

  it('changes when reply handoff ownership or ReplyLayers presentation eligibility changes', () => {
    const route = message({
      id: 'route',
      type: 'system',
      catId: undefined,
      content: 'codex-sol → codex-astra',
      extra: {
        a2aRouting: {
          fromCatId: 'codex-sol',
          targetCatId: 'codex-astra',
          invocationId: 'parent-1',
        },
      },
    });
    const queuedRoute = message({
      ...route,
      content: 'codex-sol ⇢ codex-astra',
      extra: {
        a2aRouting: {
          ...route.extra?.a2aRouting,
          fromCatId: 'codex-sol',
          targetCatId: 'codex-astra',
          routing: { mode: 'serial', index: 2, total: 2 },
        },
      },
    });
    const companion = message({
      extra: {
        ...message().extra,
        liveCompanion: {
          modality: 'voice',
          identity: {
            v: 1,
            name: '猫猫球',
            partner: { catId: 'fable-5', displayName: '宪宪', skin: 'xianxian' },
            live: { catId: 'codex-sol', displayName: '砚砚', transport: 'gpt_live_v3', verifiedModel: null },
            deep: { catId: 'fable-5', displayName: '宪宪', verifiedModel: null },
          },
        },
      },
    });

    expect(buildChatTimelineProjectionKey([queuedRoute])).not.toBe(buildChatTimelineProjectionKey([route]));
    expect(buildChatTimelineProjectionKey([companion])).not.toBe(buildChatTimelineProjectionKey([message()]));
  });

  it('tracks canonical terminal renderability without keying ordinary visible-text changes', () => {
    const visible = message({
      isStreaming: false,
      content: 'visible one',
      extra: { stream: { invocationId: 'parent-1', turnInvocationId: 'turn-1' } },
    });
    const stillVisible = { ...visible, content: 'visible two' };
    const identityOnly = { ...visible, content: '' };
    const withTool = {
      ...identityOnly,
      toolEvents: [{ id: 'read', type: 'tool_use' as const, label: 'Read', timestamp: 2 }],
    };

    expect(buildChatTimelineProjectionKey([stillVisible])).toBe(buildChatTimelineProjectionKey([visible]));
    expect(buildChatTimelineProjectionKey([identityOnly])).not.toBe(buildChatTimelineProjectionKey([visible]));
    expect(buildChatTimelineProjectionKey([withTool])).not.toBe(buildChatTimelineProjectionKey([identityOnly]));
  });

  it('tracks cross-thread renderability against the thread that owns the surface', () => {
    const crossThreadOnly = message({
      isStreaming: false,
      content: '',
      extra: { crossPost: { sourceThreadId: 'thread-source' } },
    });

    expect(buildChatTimelineProjectionKey([crossThreadOnly], 'thread-source')).not.toBe(
      buildChatTimelineProjectionKey([crossThreadOnly], 'thread-target'),
    );
  });
});
