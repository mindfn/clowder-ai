import type { ThreadProposal } from '@cat-cafe/shared';
import type { OwnerAuthProvenance } from '../domains/cats/services/agents/invocation/owner-auth-provenance.js';
import { appendApprovedInitialMessage } from './proposal-approve-dispatch.js';
import type { ProposalRoutesOptions } from './proposal-route-options.js';

export interface ReconcileApprovedSeedDeps
  extends Pick<
    ProposalRoutesOptions,
    'messageStore' | 'threadStore' | 'socketManager' | 'router' | 'invocationQueue' | 'queueProcessor'
  > {
  proposal: ThreadProposal;
  userId: string;
  ownerAuthProvenance: OwnerAuthProvenance;
}

/**
 * #1387: idempotently append the child seed for an already-approved proposal whose
 * first approve finalized the thread but failed to dispatch the initial message.
 * Returns any warnings from the best-effort dispatch.
 */
export async function reconcileApprovedInitialMessage({
  proposal,
  userId,
  ownerAuthProvenance,
  messageStore,
  threadStore,
  socketManager,
  router,
  invocationQueue,
  queueProcessor,
}: ReconcileApprovedSeedDeps): Promise<string[]> {
  const threadId = proposal.createdThreadId!;
  // Best-effort source-thread title: a transient store failure here must not
  // drop dispatch after the proposal has already been finalized.
  let sourceThreadTitle: string | null | undefined;
  try {
    sourceThreadTitle = (await threadStore.get(proposal.sourceThreadId))?.title;
  } catch {
    sourceThreadTitle = undefined;
  }
  // Idempotency check: newer seeds carry a durable key; legacy seeds carry the
  // crossPost sourceThreadId marker. Bail out if either is present.
  const idempotentSeed = await messageStore.getByIdempotencyKey(
    userId,
    threadId,
    `proposal-initial:${proposal.proposalId}`,
  );
  if (idempotentSeed) return [];
  const legacySeed = (
    await messageStore.getByThread(threadId, 10, userId, {
      includeQueuedCatMessages: true,
      includeQueuedUserMessages: true,
    })
  ).find((m) => m.extra?.crossPost?.sourceThreadId === proposal.sourceThreadId);
  if (legacySeed) return [];

  const warnings: string[] = [];
  try {
    const result = await appendApprovedInitialMessage({
      proposalId: proposal.proposalId,
      userId,
      ownerAuthProvenance,
      threadId,
      rawInitialMessage: proposal.initialMessage,
      sourceEnvelope: {
        title: proposal.title,
        reason: proposal.reason,
        sourceMessageId: proposal.sourceMessageId,
      },
      sourceThreadId: proposal.sourceThreadId,
      sourceThreadTitle,
      preferredCats: proposal.preferredCats,
      reportingMode: proposal.reportingMode,
      sourceCatId: proposal.sourceCatId,
      sourceInvocationId: proposal.sourceInvocationId,
      messageStore,
      threadStore,
      socketManager,
      router,
      invocationQueue,
      queueProcessor,
    });
    if (result.warning) warnings.push(result.warning);
  } catch (err) {
    warnings.push(`initialMessage append failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return warnings;
}
