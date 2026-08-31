import type { ThreadProposal } from '@cat-cafe/shared';
import type { OwnerAuthProvenance } from '../domains/cats/services/agents/invocation/owner-auth-provenance.js';
import type { IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import type { SocketManager } from '../infrastructure/websocket/index.js';
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
  const sourceThread = await threadStore.get(proposal.sourceThreadId);
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
      sourceThreadTitle: sourceThread?.title,
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
