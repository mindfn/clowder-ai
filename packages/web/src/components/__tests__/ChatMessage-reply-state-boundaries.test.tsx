import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ChatMessage } from '@/stores/chat-types';
import {
  installReplyLayersActEnvironment,
  ReplyLayersHarness,
  streamReply,
  uninstallReplyLayersActEnvironment,
} from './ChatMessage-reply-layers.harness';

describe('F322 reply presentation state boundaries', () => {
  let harness: ReplyLayersHarness;

  beforeAll(installReplyLayersActEnvironment);
  afterAll(uninstallReplyLayersActEnvironment);
  beforeEach(() => {
    harness = new ReplyLayersHarness();
    harness.enableV2();
  });
  afterEach(() => harness.dispose());

  it.each([
    ['an uncatalogued source', streamReply({ catId: 'retired-cat' }), {}],
    ['a compact reply', streamReply(), { compact: true }],
    [
      'an identity-only reply',
      streamReply({ isStreaming: false, content: '', toolEvents: [], thinking: undefined }),
      {},
    ],
    [
      'a companion reply',
      streamReply({
        extra: {
          stream: { invocationId: 'parent-1', turnInvocationId: 'turn-1' },
          liveCompanion: {
            modality: 'voice',
            identity: {
              v: 1,
              name: '猫猫球',
              partner: { catId: 'codex-astra', displayName: 'Astra', skin: 'astra' },
              live: { catId: 'opus', displayName: '宪宪', transport: 'gpt_live_v3', verifiedModel: null },
              deep: { catId: 'codex-astra', displayName: 'Astra', verifiedModel: null },
            },
          },
        },
      }),
      {},
    ],
  ] as const)('keeps the durable handoff standalone when %s has no ReplyLayers renderer', (_label, reply, options) => {
    const fromCatId = reply.catId;
    if (!fromCatId) throw new Error('test reply must have an author');
    const routing: ChatMessage = {
      id: 'route-fallback',
      type: 'system',
      content: `${fromCatId} → codex-astra`,
      timestamp: reply.timestamp + 1,
      extra: {
        systemKind: 'a2a_routing',
        a2aRouting: { fromCatId, targetCatId: 'codex-astra', invocationId: 'parent-1' },
      },
    };

    harness.renderTimeline([reply, routing], new Map(), options);

    expect(harness.container.querySelectorAll('[data-testid="reply-handoff"]')).toHaveLength(1);
    expect(harness.q('reply-handoff')?.textContent).toContain('交给');
    expect(harness.container.querySelector('[data-message-id="route-fallback"]')?.textContent).not.toBe('');
  });

  it.each([
    'succeeded',
    'canceled',
    'failed',
  ] as const)('exposes terminal recall for %s despite a stale streaming flag', (phase) => {
    const reply = replyWithReconciliation(phase, true);
    harness.renderTimeline([reply], recallFor(reply));

    expect(harness.q('reply-recall')?.textContent).toBe('召回 1');
    harness.click('reply-record-toggle');
    expect(harness.q('reply-record-recall')?.textContent).toBe('检索 1');
  });

  it('does not present recall as terminal while reconciliation is unknown-running', () => {
    const reply = replyWithReconciliation('unknown_running', false);
    harness.renderTimeline([reply], recallFor(reply));

    expect(harness.q('reply-status')?.textContent).toBe('状态暂不可核对');
    expect(harness.q('reply-recall')).toBeNull();
  });
});

function replyWithReconciliation(
  phase: 'succeeded' | 'canceled' | 'failed' | 'unknown_running',
  isStreaming: boolean,
): ChatMessage {
  return streamReply({
    isStreaming,
    extra: {
      stream: { invocationId: 'parent-1', turnInvocationId: 'turn-1' },
      invocationReconciliation: {
        v: 1,
        invocationId: 'parent-1',
        catIds: ['opus'],
        turnInvocationIds: ['turn-1'],
        phase,
        updatedAt: Date.UTC(2026, 9, 5, 3, 0),
      },
    },
  });
}

function recallFor(reply: ChatMessage) {
  return new Map([
    [
      reply.id,
      {
        invocationId: 'turn-1',
        catId: 'opus',
        status: 'ready' as const,
        events: [{ id: 'search', query: 'F322', timestamp: 1, toolName: 'search_evidence' }],
      },
    ],
  ]);
}
