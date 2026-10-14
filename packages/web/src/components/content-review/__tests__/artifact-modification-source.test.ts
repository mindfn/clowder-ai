import type { ArtifactReviewRound, ArtifactReviewView } from '@cat-cafe/shared';
import { describe, expect, it } from 'vitest';
import { artifactRoundChatTarget, artifactRoundRequestSource } from '../artifact-modification-source';

const view = {
  review: {
    reviewId: 'review-9',
    revision: 5,
    title: '猫咖秋日封面',
    task: { taskId: 'task-1', threadId: 'thread-1', ownerUserId: 'operator' },
  },
  authority: { taskRevision: 7, ownerCatId: 'codex-astra' },
} as unknown as ArtifactReviewView;

const round = (extra: Record<string, unknown> = {}) =>
  ({
    number: 2,
    asset: { mediaType: 'image/png', contentRef: 'content-1', ownerRevision: 4 },
    ...extra,
  }) as unknown as ArtifactReviewRound;

describe('artifactRoundChatTarget — what 「引用到聊天」 names for a media round', () => {
  it('names the same source and Task as a modification request, under the review title', () => {
    expect(artifactRoundChatTarget(view, round())).toEqual({
      title: '猫咖秋日封面',
      mediaType: 'image/png',
      source: { kind: 'artifact-review', reviewId: 'review-9', round: 2, expectedReviewRevision: 5 },
      taskContext: {
        kind: 'media',
        taskId: 'task-1',
        expectedTaskRevision: 7,
        reviewId: 'review-9',
        expectedReviewRevision: 5,
        round: 2,
      },
    });
  });

  it('is null while the ledger version is unverified, and for a type a media message cannot carry', () => {
    expect(artifactRoundChatTarget(view, round({ ledgerRef: 'ledger-1' }))).toBeNull();
    const jpeg = round({ asset: { mediaType: 'image/jpeg', contentRef: 'content-1', ownerRevision: 4 } });
    expect(artifactRoundChatTarget(view, jpeg)).toBeNull();
  });
});

describe('artifactRoundRequestSource — the source and Task a media round is modified under', () => {
  it('names the round of an inline review and the Task that already owns it', () => {
    expect(artifactRoundRequestSource(view, round())).toEqual({
      source: { kind: 'artifact-review', reviewId: 'review-9', round: 2, expectedReviewRevision: 5 },
      taskContext: {
        kind: 'media',
        taskId: 'task-1',
        expectedTaskRevision: 7,
        reviewId: 'review-9',
        expectedReviewRevision: 5,
        round: 2,
      },
    });
  });

  it('names a published round by its owner revision and the ledger that carries it, under the same Task', () => {
    expect(artifactRoundRequestSource(view, round({ ledgerRef: 'ledger-1', ledgerRevision: 3 }))).toEqual({
      source: {
        kind: 'publication',
        contentRef: 'content-1',
        ownerRevision: 4,
        ledgerRef: 'ledger-1',
        expectedLedgerRevision: 3,
      },
      taskContext: {
        kind: 'media',
        taskId: 'task-1',
        expectedTaskRevision: 7,
        reviewId: 'review-9',
        expectedReviewRevision: 5,
        round: 2,
      },
    });
  });

  it('says nothing is known yet while the ledger version of a published round is unverified', () => {
    expect(artifactRoundRequestSource(view, round({ ledgerRef: 'ledger-1' }))).toBeNull();
  });
});
