import type { UnifiedAttentionItemV1 } from '@cat-cafe/shared';
import { describe, expect, it } from 'vitest';
import { resolveOriginalPlace } from '../original-place';

const work = (kind: 'judgment' | 'repair', receipt: Record<string, unknown>): UnifiedAttentionItemV1 => ({
  decisionRef: 'd:1',
  kind,
  summary: '受托工作',
  linkedNeedsMe: [
    {
      ownerRead: { envelope: { subjectRef: 't', revision: 1, visibility: { ownerUserId: 'owner-1' } } },
      receipt: { eligible: true, kind, producer: { producerId: 'p', subjectRef: 's', revision: 1 }, ...receipt },
    },
  ] as never,
});

const approval = (
  sourceFeatureId: string,
  navigation: Record<string, unknown>,
  proposalId = 'p1',
): UnifiedAttentionItemV1 =>
  ({
    decisionRef: `approval:${sourceFeatureId}:${proposalId}`,
    kind: 'approval',
    summary: '审批',
    approval: { proposalId, sourceFeatureId, requesterCatId: 'opus', summary: 's', detail: {}, navigation },
    linkedNeedsMe: [],
  }) as unknown as UnifiedAttentionItemV1;

const anchored = {
  state: 'anchored',
  originRef: { kind: 'message', threadId: 'origin-thread', messageId: 'origin-msg' },
  approvalCardRef: { threadId: 'card-thread', messageId: 'card-msg' },
};

describe('where a 待办 row can really take you, decided only from what the read carries', () => {
  describe('等你判断 / 需要修复', () => {
    it('a standalone native question opens its canonical Thread card', () => {
      const item: UnifiedAttentionItemV1 = {
        decisionRef: 'f306.runtime_interaction:standalone-1',
        kind: 'judgment',
        summary: '在哪里验收？',
        choiceRequest: {
          interactionId: 'standalone-1',
          revision: 20,
          requesterCatId: 'codex-sol',
          createdAt: 10,
          title: '选择环境',
          questions: [{ id: 'env', header: '环境', question: '在哪里验收？' }],
          cardRef: { threadId: 'source-thread', messageId: 'source-message', blockId: 'source-card' },
        },
        linkedNeedsMe: [],
      };
      expect(resolveOriginalPlace(item)).toEqual({
        kind: 'exact',
        actionRef: 'message:source-thread:source-message#source-card',
      });
    });

    it('a message action is an exact place: the source message itself', () => {
      expect(resolveOriginalPlace(work('judgment', { action: { actionRef: 'message:t1:m1#b1' } }))).toEqual({
        kind: 'exact',
        actionRef: 'message:t1:m1#b1',
      });
    });

    it('a collective-work action is an exact place', () => {
      const actionRef =
        '/collective?connectionId=con_abcdefgh&workId=work_abcdefgh&workRevision=2&channelId=general&resultEventId=evt_abcdefgh';
      expect(resolveOriginalPlace(work('repair', { action: { actionRef } }))).toEqual({ kind: 'exact', actionRef });
    });

    it.each([
      ['a meeting-intake repair', '/api/meeting-intakes/p1/retry'],
      ['an artifact review', `content-review:review-${'a'.repeat(64)}`],
      ['a ref this build cannot read', 'something-new:xyz'],
    ])('%s needs the workspace’s own surface, which the panel does not have: it says so and offers the list', (_name, actionRef) => {
      expect(resolveOriginalPlace(work('judgment', { action: { actionRef } }))).toEqual({
        kind: 'list',
        destination: 'needs-me',
      });
    });

    it('with no usable action at all it is the list, never a guessed place', () => {
      for (const receipt of [{}, { action: {} }, { action: { actionRef: '  ' } }, { action: { actionRef: 7 } }]) {
        expect(resolveOriginalPlace(work('judgment', receipt))).toEqual({ kind: 'list', destination: 'needs-me' });
      }
    });

    it('does not borrow the action of the other kind', () => {
      const item = work('repair', { kind: 'judgment', action: { actionRef: 'message:t1:m1' } });
      expect(resolveOriginalPlace(item)).toEqual({ kind: 'list', destination: 'needs-me' });
    });
  });

  describe('审批', () => {
    it('a decision made in the approval hub opens the exact original proposal', () => {
      expect(resolveOriginalPlace(approval('F128', anchored))).toEqual({
        kind: 'exact',
        actionRef: 'message:card-thread:card-msg',
      });
    });

    it('a decision that is only available on its origin card goes to that card in the chat', () => {
      // F306 (runtime interactions) decides on its origin card; the catalog, not this test, says which features do.
      const place = resolveOriginalPlace(approval('F306', anchored));
      expect(place).toEqual({ kind: 'exact', actionRef: 'message:card-thread:card-msg' });
    });

    it('an origin-card decision whose card is not anchored cannot be located, and says it is the list', () => {
      const place = resolveOriginalPlace(approval('F306', { state: 'legacy_unanchored', legacyThreadId: 't' }));
      expect(place).toEqual({ kind: 'list', destination: 'approval' });
    });

    it('a readable anchor remains reachable for an unknown producer', () => {
      expect(resolveOriginalPlace(approval('F999', anchored))).toEqual({
        kind: 'exact',
        actionRef: 'message:card-thread:card-msg',
      });
    });
  });
});
