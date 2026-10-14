import type { InvocationQueue } from '../cats/services/agents/invocation/InvocationQueue.js';
import { carrierEntryId } from '../cats/services/agents/invocation/QueuedMessageCustodyCarrierProjection.js';
import { getQueueReadEvidence } from '../cats/services/agents/invocation/QueueReadEvidence.js';
import { isDispatchSource } from '../cats/services/agents/invocation/queue-source-completion-policy.js';
import type { IMessageStore } from '../cats/services/stores/ports/MessageStore.js';
import type { ITurnExecutionStore } from '../cats/services/stores/ports/TurnExecutionStore.js';
import type { LiveCompanionSessions } from '../concierge/live/LiveCompanionSessions.js';
import {
  type A2ADispatchDispositionAuth,
  A2ADispatchDispositionError,
  type DispatchAdoptionProof,
  type ReadEvidenceWitness,
} from './A2ADispatchDispositionService.js';
import type { TurnCustodyAdoptionRegistry } from './TurnCustodyAdoptionRegistry.js';

interface Dependencies {
  executions: Pick<ITurnExecutionStore, 'get'>;
  messages: Pick<IMessageStore, 'getById'>;
  adoptions: TurnCustodyAdoptionRegistry;
  live?: Pick<LiveCompanionSessions, 'withCarrierOperation'>;
  queue?: Pick<InvocationQueue, 'isExactUnmergedSourceCurrent' | 'withExactUnmergedSourceCommit'>;
}

interface ExactLiveSourceCoordinates {
  readonly ownerUserId: string;
  readonly entryId: string;
  readonly alreadySettledByInvocation: boolean;
}

/** Carrier admission is separate from the exact dispatch event writer and its receipt projection. */
export class DispatchAdoptionAuthority {
  constructor(private readonly deps: Dependencies) {}

  async run<T>(
    auth: A2ADispatchDispositionAuth,
    messageId: string,
    consume: (proof: DispatchAdoptionProof) => Promise<T>,
  ): Promise<T> {
    const execution = await this.assertExecution(auth);
    if (execution.queueCompletionPolicy === 'explicit_source') {
      if (!this.deps.live) throw new A2ADispatchDispositionError('adopted_dispatch_unavailable');
      // A closing Live carrier never falls through to ordinary admission.
      return this.deps.live.withCarrierOperation(auth, async () => {
        const witness = await getQueueReadEvidence(this.deps.messages, { ...auth, messageId });
        if (!witness) throw new A2ADispatchDispositionError('adopted_dispatch_not_read');
        return consume({
          carrierKind: 'live',
          witness,
          ...(witness.evidenceKind === 'exact_full_message'
            ? {
                assertSourceCurrent: async () => {
                  await this.assertExactLiveSourceCurrent(auth, messageId);
                },
                withSourceCurrentCommit: async <T>(commit: () => Promise<T>) =>
                  this.withExactLiveSourceCurrentCommit(auth, messageId, commit),
              }
            : {}),
        });
      });
    }
    if (!this.deps.adoptions.isAccepting(auth.invocationId))
      throw new A2ADispatchDispositionError('adopted_dispatch_inactive_invocation');
    return this.deps.adoptions.withOperation(auth, async (lease) => {
      await this.assertExecution(auth);
      if (!lease.matches(auth)) throw new A2ADispatchDispositionError('adopted_dispatch_inactive_invocation');
      return consume({
        carrierKind: 'ordinary',
        witness: await this.readOrdinarySource(auth, messageId),
        assertSourceCurrent: async () => {
          await this.readOrdinarySource(auth, messageId);
        },
      });
    });
  }

  async candidates(auth: A2ADispatchDispositionAuth, messageIds: readonly string[]): Promise<string[]> {
    const execution = await this.assertExecution(auth);
    if (execution.queueCompletionPolicy === 'explicit_source' || !this.deps.adoptions.isAccepting(auth.invocationId))
      return [];
    const candidates: string[] = [];
    for (const id of new Set(messageIds)) {
      try {
        await this.readOrdinarySource(auth, id);
        const message = await this.deps.messages.getById(id);
        if (!message?.queueCustody?.handledByCatIds.includes(auth.catId)) candidates.push(id);
      } catch (error) {
        if (!(error instanceof A2ADispatchDispositionError)) throw error;
      }
    }
    return candidates;
  }

  private async assertExecution(auth: A2ADispatchDispositionAuth) {
    const execution = await this.deps.executions.get(auth.invocationId);
    if (
      !auth.userId ||
      !execution ||
      execution.status !== 'running' ||
      execution.userId !== auth.userId ||
      execution.threadId !== auth.threadId ||
      execution.catId !== auth.catId
    ) {
      throw new A2ADispatchDispositionError('adopted_dispatch_inactive_invocation');
    }
    return execution;
  }

  private async readOrdinarySource(auth: A2ADispatchDispositionAuth, messageId: string): Promise<ReadEvidenceWitness> {
    const message = await this.deps.messages.getById(messageId);
    const custody = message?.queueCustody;
    if (
      !message ||
      message.deletedAt ||
      !custody ||
      message.threadId !== auth.threadId ||
      (custody.ownerUserId ?? message.userId) !== auth.userId ||
      !isDispatchSource(message, auth.catId) ||
      !custody.allTargetCats.includes(auth.catId) ||
      custody.withdrawnByCatIds?.includes(auth.catId) ||
      message.deliveryStatus === 'canceled'
    ) {
      throw new A2ADispatchDispositionError('a2a_dispatch_disposition_source_mismatch');
    }
    const exposure = custody.bodyExposures?.find(
      (e) => e.targetCatId === auth.catId && e.invocationId === auth.invocationId,
    );
    if (!exposure) throw new A2ADispatchDispositionError('adopted_dispatch_not_read');
    return { messageId, seenAt: exposure.seenAt, evidenceKind: 'queued_body_exposure' };
  }

  /**
   * An exact stored-message witness covers the Queue carrier only while that
   * carrier is still the same unmerged singleton. A later coalesce changes the
   * body and must require a fresh complete-carrier read before disposition.
   */
  private async assertExactLiveSourceCurrent(auth: A2ADispatchDispositionAuth, messageId: string): Promise<void> {
    const coordinates = await this.readExactLiveSourceCoordinates(auth, messageId);
    if (coordinates.alreadySettledByInvocation) return;
    if (
      !this.deps.queue?.isExactUnmergedSourceCurrent({
        threadId: auth.threadId,
        userId: coordinates.ownerUserId,
        entryId: coordinates.entryId,
        messageId,
        targetCatId: auth.catId,
      })
    ) {
      throw new A2ADispatchDispositionError('adopted_dispatch_not_read');
    }
  }

  private async withExactLiveSourceCurrentCommit<T>(
    auth: A2ADispatchDispositionAuth,
    messageId: string,
    commit: () => Promise<T>,
  ): Promise<T> {
    const coordinates = await this.readExactLiveSourceCoordinates(auth, messageId);
    if (coordinates.alreadySettledByInvocation) {
      throw new A2ADispatchDispositionError('adopted_dispatch_not_read');
    }
    const queue = this.deps.queue;
    if (!queue) throw new A2ADispatchDispositionError('adopted_dispatch_not_read');
    const result = await queue.withExactUnmergedSourceCommit(
      {
        threadId: auth.threadId,
        userId: coordinates.ownerUserId,
        entryId: coordinates.entryId,
        messageId,
        targetCatId: auth.catId,
      },
      async () => {
        const current = await this.readExactLiveSourceCoordinates(auth, messageId);
        if (
          current.alreadySettledByInvocation ||
          current.ownerUserId !== coordinates.ownerUserId ||
          current.entryId !== coordinates.entryId
        ) {
          throw new A2ADispatchDispositionError('adopted_dispatch_not_read');
        }
        return commit();
      },
    );
    if (result.outcome === 'unavailable') {
      throw new A2ADispatchDispositionError('adopted_dispatch_not_read');
    }
    return result.value;
  }

  private async readExactLiveSourceCoordinates(
    auth: A2ADispatchDispositionAuth,
    messageId: string,
  ): Promise<ExactLiveSourceCoordinates> {
    const message = await this.deps.messages.getById(messageId);
    const custody = message?.queueCustody;
    const ownerUserId = custody?.ownerUserId ?? message?.userId;
    const exactOutcome = custody?.targetOutcomeByCatId?.[auth.catId];
    // Preserve same-invocation idempotency after its successful receipt prunes
    // the physical Queue entry. A different invocation cannot inherit it.
    const alreadySettledByInvocation = Boolean(
      custody?.handledByCatIds.includes(auth.catId) &&
        exactOutcome?.disposition === 'dispatch_disposition' &&
        exactOutcome.invocationId === auth.invocationId,
    );
    const entryId = custody ? carrierEntryId(custody, auth.catId) : undefined;
    if (!alreadySettledByInvocation && message?.deliveryStatus !== 'queued') {
      throw new A2ADispatchDispositionError('adopted_dispatch_not_read');
    }
    if (!alreadySettledByInvocation && custody?.status === 'terminal') {
      throw new A2ADispatchDispositionError('adopted_dispatch_not_read');
    }
    if (
      !auth.userId ||
      !message ||
      message.deletedAt ||
      !custody ||
      message.threadId !== auth.threadId ||
      ownerUserId !== auth.userId ||
      !isDispatchSource(message, auth.catId) ||
      !custody.allTargetCats.includes(auth.catId) ||
      custody.withdrawnByCatIds?.includes(auth.catId) ||
      message.deliveryStatus === 'canceled' ||
      !ownerUserId ||
      !entryId
    ) {
      throw new A2ADispatchDispositionError('adopted_dispatch_not_read');
    }
    return { ownerUserId, entryId, alreadySettledByInvocation };
  }
}
