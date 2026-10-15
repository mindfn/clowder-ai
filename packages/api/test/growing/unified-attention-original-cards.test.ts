import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  ApprovalHubItem,
  ApprovalProducerId,
  ProfileUpdateProposal,
  RichCardBlock,
  SessionHandoffProposal,
} from '@cat-cafe/shared';
import Fastify from 'fastify';
import { buildApprovalCardBlock } from '../../src/domains/approval-hub/buildApprovalCardBlock.js';
import { buildHandoffProposalCardBlock } from '../../src/domains/cats/services/session/sessionHandoffPropose.js';
import { MessageStore } from '../../src/domains/cats/services/stores/ports/MessageStore.js';
import { readCompanionDecisionProjection } from '../../src/routes/companion-decision-read-service.js';
import { buildProfileUpdateCardBlock } from '../../src/routes/profile-update-card-block.js';
import { approval } from './unified-attention-fixtures.js';

const ownerUserId = 'owner';
const requesterCatId = 'codex-sol';
const cardThreadId = 'thread-card';

function originalCard(producerId: 'F225' | 'F231', proposalId: string): RichCardBlock {
  const featureCard =
    producerId === 'F225'
      ? buildHandoffProposalCardBlock(handoffProposal(proposalId))
      : buildProfileUpdateCardBlock(profileProposal(proposalId));
  return buildApprovalCardBlock({ producerId, canonicalProposalId: proposalId }, featureCard) as RichCardBlock;
}

function handoffProposal(proposalId: string): SessionHandoffProposal {
  return {
    kind: 'session_handoff',
    proposalId,
    status: 'pending',
    sourceThreadId: cardThreadId,
    sourceSessionId: 'session-one',
    sourceCatId: requesterCatId as never,
    sourceMessageId: 'origin-message',
    userId: ownerUserId,
    note: {
      proposalId,
      sourceSessionId: 'session-one',
      done: 'Finished the current step',
      nextSteps: 'Continue after approval',
      persistedAt: 10,
    },
    createdAt: 10,
    updatedAt: 10,
  };
}

function profileProposal(proposalId: string): ProfileUpdateProposal {
  return {
    proposalId,
    status: 'pending',
    sourceThreadId: cardThreadId,
    sourceInvocationId: 'invocation-one',
    sourceCatId: requesterCatId as never,
    targetLayer: 'primer',
    targetPath: 'relationship/sol-primer.md',
    beforeContent: 'before',
    baseContentHash: 'hash',
    afterContent: 'after',
    rationale: 'Keep the relationship fact current',
    signalProvenance: {
      kind: 'message-coordinate',
      sourceThreadId: cardThreadId,
      sourceMessageId: 'origin-message',
    },
    createdBy: ownerUserId,
    createdAt: 10,
  };
}

async function projectOriginalCard(input: {
  producerId?: 'F225' | 'F231';
  proposalId?: string;
  blocks?: RichCardBlock[];
  messageOwner?: string;
  messageRequester?: string;
  rowThreadId?: string;
  deleteMessage?: boolean;
}) {
  const producerId = input.producerId ?? 'F225';
  const proposalId = input.proposalId ?? 'proposal-one';
  const messages = new MessageStore();
  const stored = await messages.append({
    userId: input.messageOwner ?? ownerUserId,
    catId: (input.messageRequester ?? requesterCatId) as never,
    threadId: cardThreadId,
    content: 'canonical original approval card',
    mentions: [],
    timestamp: 10,
    extra: { rich: { v: 1, blocks: input.blocks ?? [originalCard(producerId, proposalId)] } },
  });
  if (input.deleteMessage) await messages.softDelete(stored.id, ownerUserId);
  const row: ApprovalHubItem = {
    ...approval(proposalId, producerId),
    requesterCatId,
    navigation: {
      state: 'anchored',
      originRef: { kind: 'message', threadId: input.rowThreadId ?? cardThreadId, messageId: 'origin-message' },
      approvalCardRef: { threadId: input.rowThreadId ?? cardThreadId, messageId: stored.id },
    },
  };
  const app = Fastify();
  app.get('/api/approval-hub/pending', async () => ({ items: [row], coverage: { state: 'complete' } }));
  app.get('/api/entrusted-work/needs-me', async () => ({ ownerReads: [], coverage: { state: 'complete' } }));
  const result = await readCompanionDecisionProjection(app, ownerUserId, { offset: 0, limit: 20 }, messages);
  await app.close();
  return { result, stored, row };
}

for (const producerId of ['F225', 'F231'] as const satisfies readonly ApprovalProducerId[]) {
  test(`${producerId} exposes the verified original approval card without changing inline authority`, async () => {
    const { result, stored } = await projectOriginalCard({ producerId });
    const item = result.items[0] as (typeof result.items)[number] & {
      originalApprovalCard?: {
        cardRef: { threadId: string; messageId: string; blockId: string };
        block: RichCardBlock;
      };
    };

    assert.equal(item.approval?.inlineApprovable, false);
    assert.deepEqual(item.originalApprovalCard?.cardRef, {
      threadId: cardThreadId,
      messageId: stored.id,
      blockId: originalCard(producerId, 'proposal-one').id,
    });
    assert.deepEqual(item.originalApprovalCard?.block, originalCard(producerId, 'proposal-one'));
    assert.equal(result.consistency.state, 'verified');
    assert.equal(result.totalCount, 1);
  });
}

for (const [name, mutate] of [
  ['foreign owner', () => ({ messageOwner: 'other-owner' })],
  ['foreign thread', () => ({ rowThreadId: 'other-thread' })],
  ['foreign requester', () => ({ messageRequester: 'other-cat' })],
  ['deleted card', () => ({ deleteMessage: true })],
  [
    'multiple ingress stamps',
    () => ({
      blocks: [originalCard('F225', 'proposal-one'), originalCard('F225', 'proposal-one')],
    }),
  ],
  ['wrong proposal stamp', () => ({ blocks: [originalCard('F225', 'another-proposal')] })],
  [
    'wrong action payload',
    () => {
      const block = originalCard('F225', 'proposal-one');
      return {
        blocks: [
          {
            ...block,
            actions: block.actions?.map((action, index) =>
              index === 0 ? { ...action, payload: { proposalId: 'another-proposal' } } : action,
            ),
          },
        ],
      };
    },
  ],
] as const) {
  test(`${name} withholds write-capable original-card proof and every exact count`, async () => {
    const { result } = await projectOriginalCard(mutate());
    const item = result.items[0] as (typeof result.items)[number] & { originalApprovalCard?: unknown };
    assert.equal(item.originalApprovalCard, undefined);
    assert.equal(result.consistency.state, 'uncertain');
    assert.ok(result.consistency.reasons.includes('original_approval_card_unverified'));
    assert.equal(result.totalCount, undefined);
    assert.equal(result.attentionCount, undefined);
  });
}
