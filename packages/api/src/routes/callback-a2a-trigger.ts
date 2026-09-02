/**
 * A2A invocation trigger for MCP callback post_message (F27 rewrite).
 *
 * Callback mentions enter the same InvocationQueue lifecycle as every other
 * message. There is no direct routeExecution fallback.
 */

import type { CatId } from '@cat-cafe/shared';
import type { ActionSuccessorFence } from '../domains/ball-custody/ActionSuccessorAdmissionService.js';
import type { IBallCustodyIngest } from '../domains/ball-custody/BallCustodyIngest.js';
import { buildHandedEvent } from '../domains/ball-custody/ball-custody-events.js';
import type { InvocationQueue, QueueEntry } from '../domains/cats/services/agents/invocation/InvocationQueue.js';
import {
  normalizeOwnerAuthProvenance,
  type OwnerAuthProvenance,
} from '../domains/cats/services/agents/invocation/owner-auth-provenance.js';
import { queueEntryId } from '../domains/cats/services/agents/invocation/queue-ledger/QueueLedger.js';
import {
  callerActivityFromMessage,
  type DurableA2ALineage,
  readDurableA2ALineage,
} from '../domains/cats/services/agents/routing/durable-a2a-lineage.js';
import type { CallerActivity } from '../domains/cats/services/agents/routing/WorklistRegistry.js';
import {
  getWorklist,
  peekStreakOnPush,
  updateStreakOnPush,
} from '../domains/cats/services/agents/routing/WorklistRegistry.js';
import type {
  AppendMessageInput,
  IMessageStore,
  LifecycleResponseTerminalPatch,
  StoredMessage,
} from '../domains/cats/services/stores/ports/MessageStore.js';
import {
  commitLifecycleResponseFromAppendInput,
  lifecycleResponseTerminalPatchFromAppendInput,
  settleLifecycleResponseInputs,
} from '../domains/cats/services/stores/ports/MessageStore.js';
import { wrapWithDispatchSpan } from '../infrastructure/telemetry/dispatch-span.js';
import type { CallerTraceContext } from '../infrastructure/telemetry/genai-semconv.js';
import { emitQueueUpdated } from '../utils/queue-enrichment.js';

interface A2ATriggerSocketManager {
  emitToUser(userId: string, event: string, data: unknown): void;
  broadcastAgentMessage(message: unknown, threadId: string): void;
}

interface A2ATriggerLogger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

export interface QueueProcessorLike {
  requestDrain?(threadId: string): Promise<void>;
  tryAutoAppendExactEntry?(input: {
    threadId: string;
    userId: string;
    entryId: string;
  }): Promise<{ outcome: 'appended' | 'rejected' }>;
  /** F216 c3 supersede: releaseSlot force-frees the per-slot processingSlots
   * mutex so the next drain sees a free slot. */
  releaseSlot?(threadId: string, catId: string): void;
}

export interface A2ATriggerDeps {
  socketManager: A2ATriggerSocketManager;
  invocationTracker?: {
    has(threadId: string, catId: string): boolean;
    cancelInvocation(threadId: string, catIds: string[], userId?: string, reason?: string): unknown;
  };
  queueProcessor?: QueueProcessorLike;
  /** #706: MessageStore for queue enrichment (messagePreview in queue_updated SSE). */
  messageStore?: IMessageStore;
  /** F167 Phase T: persist accepted A2A dispatch custody before the child can execute. */
  ballCustody?: IBallCustodyIngest;
  /** F122B: InvocationQueue for agent-sourced entries.
   *  Same-turn handoffs remain independent scalar ledger rows. */
  invocationQueue?: Pick<
    InvocationQueue,
    | 'enqueueDurable'
    | 'appendAndEnqueueDurable'
    | 'terminalizeResponseAndEnqueueDurable'
    | 'countAgentEntriesForThread'
    | 'getEntrySnapshot'
    | 'list'
  >;
  log: A2ATriggerLogger;
}

export interface A2AFanoutAdmissionPlan {
  requestedTargetCats: readonly CatId[];
  acceptedTargetCats: readonly CatId[];
  streakTargetCats: readonly CatId[];
  stop?:
    | { reason: 'depth'; catId: CatId; currentDepth: number }
    | { reason: 'pingpong'; catId: CatId; pairCount: number };
}

export interface AtomicA2ASourceAdmission {
  message: StoredMessage;
  preAdmittedEntries?: readonly QueueEntry[];
  preAdmittedReplayed?: boolean;
}

/** Persist public Agent speech and its accepted A2A rows in one storage transaction. */
export async function appendA2ASourceWithLedgerAdmission(
  deps: Pick<A2ATriggerDeps, 'invocationQueue' | 'messageStore'>,
  message: AppendMessageInput,
  options: {
    plan: A2AFanoutAdmissionPlan;
    ownerAuthProvenance: OwnerAuthProvenance;
    parentInvocationId?: string;
    callerTraceContext?: CallerTraceContext;
    actionSuccessorFence?: ActionSuccessorFence;
  },
): Promise<AtomicA2ASourceAdmission> {
  if (!deps.messageStore) throw new Error('A2A source admission requires MessageStore');
  if (options.plan.acceptedTargetCats.length === 0) {
    return { message: await deps.messageStore.append(message) };
  }
  if (!deps.invocationQueue) throw new Error('A2A source admission requires InvocationQueue');
  if (message.from.kind !== 'agent') throw new Error('A2A source admission requires Agent speech');
  const result = await deps.invocationQueue.appendAndEnqueueDurable(deps.messageStore, message, {
    from: message.from,
    threadId: message.threadId ?? 'default',
    userId: message.userId,
    kind: 'message_wake',
    ownerAuthProvenance: normalizeOwnerAuthProvenance(options.ownerAuthProvenance),
    content: message.content,
    sourceCategory: 'a2a',
    targetCats: [...options.plan.acceptedTargetCats],
    intent: 'execute',
    autoExecute: true,
    a2aParentInvocationId: options.parentInvocationId,
    callerTraceContext: options.callerTraceContext
      ? wrapWithDispatchSpan(options.callerTraceContext, options.plan.acceptedTargetCats.length, message.from.catId)
      : undefined,
    ...(options.actionSuccessorFence ? { actionSuccessorFence: options.actionSuccessorFence } : {}),
  });
  if (result.outcome === 'full') throw new Error('A2A source Queue admission is full');
  return {
    message: result.message,
    preAdmittedEntries: result.entries,
    preAdmittedReplayed: result.deduped,
  };
}

interface A2AFanoutAdmissionOptions {
  targetCats: readonly CatId[];
  content: string;
  userId: string;
  ownerAuthProvenance: OwnerAuthProvenance;
  threadId: string;
  createdAt: number;
  callerCatId?: CatId;
  parentInvocationId?: string;
  isCrossThread?: boolean;
  actionSuccessorFence?: ActionSuccessorFence;
  durableLineage?: DurableA2ALineage;
  callerActivity?: CallerActivity;
}

/**
 * Decide the complete A2A fan-out before the source message is published.
 * This is deliberately read-only: streak mutation and Queue staging happen
 * only after the durable message + admission record has committed.
 */
export function planA2AFanoutAdmission(
  deps: Pick<A2ATriggerDeps, 'invocationQueue'>,
  opts: A2AFanoutAdmissionOptions,
): A2AFanoutAdmissionPlan {
  const invocationQueue = deps.invocationQueue;
  if (!invocationQueue) throw new Error('A2A dispatch requires InvocationQueue');
  const streakCallerCatId = opts.targetCats.length === 1 ? opts.callerCatId : undefined;
  const streakEntry = streakCallerCatId ? getWorklist(opts.threadId, opts.parentInvocationId) : null;
  const maxA2ADepth = streakEntry?.maxDepth ?? 10;
  const streakActivity =
    opts.callerActivity ??
    ({
      hadSubstantiveToolCall: false,
      outputLength: opts.content.length,
    } as const);
  const acceptedTargetCats: CatId[] = [];
  const streakTargetCats: CatId[] = [];
  let stop: A2AFanoutAdmissionPlan['stop'];
  let predictedDepth =
    opts.durableLineage?.depth ?? streakEntry?.a2aCount ?? invocationQueue.countAgentEntriesForThread(opts.threadId);
  const streakState = opts.durableLineage ?? streakEntry;

  for (const catId of opts.targetCats) {
    if (predictedDepth >= maxA2ADepth) {
      stop = { reason: 'depth', catId, currentDepth: predictedDepth };
      break;
    }
    if (streakCallerCatId && streakState) {
      const streak = peekStreakOnPush(streakState, streakCallerCatId, catId, streakActivity);
      if (streak.wouldBlock) {
        stop = { reason: 'pingpong', catId, pairCount: streak.count };
        break;
      }
      streakTargetCats.push(catId);
    }
    acceptedTargetCats.push(catId);
    predictedDepth += 1;
  }

  return {
    requestedTargetCats: [...opts.targetCats],
    acceptedTargetCats,
    streakTargetCats,
    ...(stop ? { stop } : {}),
  };
}

export async function commitCompletedResponseAndEnqueueA2ATargets(
  deps: A2ATriggerDeps,
  opts: {
    responseMessageId: string;
    invocationId: string;
    terminal: Pick<LifecycleResponseTerminalPatch, 'status' | 'completedAt' | 'reason'>;
    message: AppendMessageInput;
    targetCats: CatId[];
    userId: string;
    ownerAuthProvenance: OwnerAuthProvenance;
    threadId: string;
    callerCatId: CatId;
    parentInvocationId?: string;
    callerTraceContext?: CallerTraceContext;
  },
): Promise<StoredMessage> {
  if (opts.terminal.status !== 'completed') {
    throw new Error('completed response A2A wake requires a completed terminal');
  }
  if (!deps.messageStore) throw new Error('completed response A2A wake requires MessageStore');
  const causalTriggerMessageId = opts.message.extra?.causal?.triggerMessageId;
  const durableLineage = causalTriggerMessageId
    ? await readDurableA2ALineage(deps.messageStore, causalTriggerMessageId, opts.callerCatId)
    : undefined;
  const admissionOptions: A2AFanoutAdmissionOptions = {
    targetCats: opts.targetCats,
    content: opts.message.content,
    userId: opts.userId,
    ownerAuthProvenance: normalizeOwnerAuthProvenance(opts.ownerAuthProvenance),
    threadId: opts.threadId,
    createdAt: opts.terminal.completedAt,
    callerCatId: opts.callerCatId,
    ...(durableLineage ? { durableLineage } : {}),
    callerActivity: callerActivityFromMessage(opts.message),
    ...(opts.parentInvocationId ? { parentInvocationId: opts.parentInvocationId } : {}),
  };
  const plan = planA2AFanoutAdmission(deps, admissionOptions);
  let stored: StoredMessage;
  let preAdmittedEntries: readonly QueueEntry[] | undefined;
  let preAdmittedReplayed = false;
  if (plan.acceptedTargetCats.length > 0) {
    if (!deps.invocationQueue) throw new Error('completed response A2A wake requires InvocationQueue');
    const current = await deps.messageStore.getById(opts.responseMessageId);
    if (!current) throw new Error(`lifecycle response not found: ${opts.responseMessageId}`);
    const terminalPatch = lifecycleResponseTerminalPatchFromAppendInput(
      current,
      opts.invocationId,
      opts.terminal,
      opts.message,
    );
    const dispatchTraceContext = opts.callerTraceContext
      ? wrapWithDispatchSpan(opts.callerTraceContext, plan.acceptedTargetCats.length, opts.callerCatId)
      : undefined;
    const admission = await deps.invocationQueue.terminalizeResponseAndEnqueueDurable(
      deps.messageStore,
      opts.responseMessageId,
      terminalPatch,
      {
        from: { kind: 'agent', catId: opts.callerCatId },
        threadId: opts.threadId,
        userId: opts.userId,
        kind: 'message_wake',
        ownerAuthProvenance: normalizeOwnerAuthProvenance(opts.ownerAuthProvenance),
        content: opts.message.content,
        messageId: opts.responseMessageId,
        sourceId: opts.responseMessageId,
        sourceCategory: 'a2a',
        targetCats: [...plan.acceptedTargetCats],
        intent: 'execute',
        autoExecute: true,
        a2aParentInvocationId: opts.parentInvocationId,
        callerTraceContext: dispatchTraceContext,
        a2aTriggerMessageId: opts.responseMessageId,
      },
    );
    if (admission.outcome === 'full') throw new Error('completed response A2A Queue admission is full');
    stored = admission.message;
    preAdmittedEntries = admission.entries;
    preAdmittedReplayed = admission.deduped;
    await settleLifecycleResponseInputs(deps.messageStore, stored, opts.responseMessageId);
  } else {
    stored = await commitLifecycleResponseFromAppendInput(
      deps.messageStore,
      opts.responseMessageId,
      opts.invocationId,
      opts.terminal,
      opts.message,
    );
  }

  if (plan.acceptedTargetCats.length === 0) {
    if (plan.stop?.reason === 'depth') {
      deps.log.warn(
        {
          threadId: opts.threadId,
          triggerMessageId: stored.id,
          catId: plan.stop.catId,
          currentDepth: plan.stop.currentDepth,
        },
        '[F122B] completed response A2A: depth limit reached',
      );
    } else if (plan.stop?.reason === 'pingpong') {
      const worklist = getWorklist(opts.threadId, opts.parentInvocationId);
      if (worklist) {
        updateStreakOnPush(worklist, opts.callerCatId, plan.stop.catId, {
          hadSubstantiveToolCall: false,
          outputLength: opts.message.content.length,
        });
      }
      deps.socketManager.broadcastAgentMessage(
        {
          type: 'system_info',
          catId: opts.callerCatId,
          content: JSON.stringify({
            type: 'a2a_pingpong_terminated',
            fromCatId: opts.callerCatId,
            targetCatId: plan.stop.catId,
            pairCount: plan.stop.pairCount,
          }),
          timestamp: Date.now(),
        },
        opts.threadId,
      );
    }
    return stored;
  }

  await enqueueA2ATargets(deps, {
    targetCats: opts.targetCats,
    content: opts.message.content,
    userId: opts.userId,
    ownerAuthProvenance: opts.ownerAuthProvenance,
    threadId: opts.threadId,
    triggerMessage: stored,
    callerCatId: opts.callerCatId,
    ...(opts.parentInvocationId ? { parentInvocationId: opts.parentInvocationId } : {}),
    ...(opts.callerTraceContext ? { callerTraceContext: opts.callerTraceContext } : {}),
    preplannedAdmission: plan,
    ...(preAdmittedEntries ? { preAdmittedEntries, preAdmittedReplayed } : {}),
  });
  return (await deps.messageStore.getById(stored.id)) ?? stored;
}

/**
 * Enqueue @mentioned cats into the canonical InvocationQueue lifecycle.
 */
export async function enqueueA2ATargets(
  deps: A2ATriggerDeps,
  opts: {
    targetCats: CatId[];
    content: string;
    userId: string;
    /** Inherited unchanged from the authenticated parent invocation, or explicit unknown. */
    ownerAuthProvenance: OwnerAuthProvenance;
    threadId: string;
    triggerMessage: StoredMessage;
    /** The cat that triggered this A2A callback (for worklist caller guard). */
    callerCatId?: CatId;
    /** F108: parentInvocationId for concurrent worklist isolation. */
    parentInvocationId?: string;
    /** F153: caller trace context for cross-route A2A propagation */
    callerTraceContext?: CallerTraceContext;
    /** F167 Phase S: persistent subject/action/slot generation fence. */
    actionSuccessorFence?: ActionSuccessorFence;
    /** Exact policy plan already persisted with a newly appended source message. */
    preplannedAdmission?: A2AFanoutAdmissionPlan;
    /**
     * Register consumer-specific completion observers after canonical Queue custody is durable
     * and before any accepted carrier can start. Multi-mention uses this to aggregate sibling
     * results without owning a second dispatch/admission implementation.
     */
    onQueueEntriesAdmitted?: (entries: readonly QueueEntry[]) => void;
    /** Rows atomically admitted with a terminal response before publication side effects run. */
    preAdmittedEntries?: readonly QueueEntry[];
    preAdmittedReplayed?: boolean;
  },
): Promise<{ enqueued: CatId[]; coalesced?: CatId[] }> {
  if (!deps.invocationQueue || !deps.queueProcessor?.requestDrain) {
    throw new Error('A2A dispatch requires InvocationQueue and QueueProcessor');
  }
  const { log } = deps;
  const { threadId, callerCatId } = opts;
  const ownerAuthProvenance = normalizeOwnerAuthProvenance(opts.ownerAuthProvenance);
  const triggerMessageId = opts.triggerMessage.id;
  const isCrossThread =
    !!opts.triggerMessage.extra?.crossPost?.sourceThreadId &&
    opts.triggerMessage.extra.crossPost.sourceThreadId !== opts.triggerMessage.threadId;
  if (!deps.messageStore) {
    throw new Error('A2A Queue dispatch requires durable message custody');
  }
  const persistedQueueTrigger = await deps.messageStore.getById(triggerMessageId);
  if (
    !persistedQueueTrigger ||
    persistedQueueTrigger.from?.kind !== 'agent' ||
    persistedQueueTrigger.deliveryStatus === 'queued' ||
    persistedQueueTrigger.deliveryStatus === 'canceled' ||
    persistedQueueTrigger.visibility === 'whisper' ||
    persistedQueueTrigger.recall ||
    persistedQueueTrigger._tombstone
  ) {
    throw new Error('A2A Queue dispatch requires one persisted public agent source message');
  }
  // F167 Phase E (KD-20): L3 role-gate retired. Role-based handoff permission is
  // no longer harness-enforced — cat-config.restrictions flows into sender & target
  // prompts (buildTeammateRoster / buildStaticIdentity); cats self-regulate.
  const fromCatId = persistedQueueTrigger.from.catId as CatId;
  if (callerCatId && callerCatId !== fromCatId) {
    throw new Error('A2A Queue dispatch caller does not match persisted MessageFrom');
  }
  const targetCats = opts.targetCats;

  // F153 Phase I (Maine Coon P1): Lazy-create mention_dispatch span + a2a.dispatch.count counter
  // ONLY when a target is about to actually dispatch (passes all guards and reaches a real enqueue
  // invocation). Pre-creating would mint span/counter even when ALL cats are blocked
  // by depth limit / dedup / ping-pong streak — polluting Step Summary
  // a2a_dispatch_count with phantom dispatches.
  let dispatchTraceContext: CallerTraceContext | undefined;
  const ensureDispatchTraceContext = (): CallerTraceContext | undefined => {
    if (dispatchTraceContext === undefined && opts.callerTraceContext) {
      dispatchTraceContext = wrapWithDispatchSpan(opts.callerTraceContext, targetCats.length, fromCatId);
    }
    return dispatchTraceContext;
  };

  // ADR-043: the ledger row is the complete durable delivery work order. The
  // source message remains ordinary History and never carries Queue admission
  // or per-target custody mirrors. One source/target pair has one deterministic
  // row, so replay converges in the ledger and distinct bodies are never merged.
  const admissionOptions: A2AFanoutAdmissionOptions = {
    targetCats,
    content: opts.content,
    userId: opts.userId,
    ownerAuthProvenance,
    threadId,
    createdAt: opts.triggerMessage.timestamp,
    ...(callerCatId ? { callerCatId } : {}),
    ...(opts.parentInvocationId ? { parentInvocationId: opts.parentInvocationId } : {}),
    ...(isCrossThread ? { isCrossThread: true } : {}),
    ...(opts.actionSuccessorFence ? { actionSuccessorFence: opts.actionSuccessorFence } : {}),
  };
  const plan =
    opts.preplannedAdmission ??
    (() => {
      const replayTargets = new Set(
        targetCats.filter((catId) =>
          deps.invocationQueue?.getEntrySnapshot(threadId, opts.userId, queueEntryId(triggerMessageId, catId)),
        ),
      );
      const freshTargets = targetCats.filter((catId) => !replayTargets.has(catId));
      const freshPlan = planA2AFanoutAdmission(deps, { ...admissionOptions, targetCats: freshTargets });
      const acceptedFresh = new Set(freshPlan.acceptedTargetCats);
      return {
        requestedTargetCats: [...targetCats],
        acceptedTargetCats: targetCats.filter((catId) => replayTargets.has(catId) || acceptedFresh.has(catId)),
        streakTargetCats: freshPlan.streakTargetCats,
        ...(freshPlan.stop ? { stop: freshPlan.stop } : {}),
      };
    })();
  if (JSON.stringify(plan.requestedTargetCats) !== JSON.stringify(targetCats)) {
    throw new Error('A2A fan-out admission plan requested-target mismatch');
  }
  if (plan.acceptedTargetCats.some((catId) => !targetCats.includes(catId))) {
    throw new Error('A2A fan-out admission plan contains an unrequested target');
  }

  if (plan.stop?.reason === 'depth') {
    log.warn(
      { threadId, triggerMessageId, currentDepth: plan.stop.currentDepth, catId: plan.stop.catId },
      '[F122B] A2A callback: depth limit reached, skipping remaining targets',
    );
  } else if (plan.stop?.reason === 'pingpong' && callerCatId) {
    const worklist = getWorklist(threadId, opts.parentInvocationId);
    if (worklist) {
      updateStreakOnPush(worklist, callerCatId, plan.stop.catId, {
        hadSubstantiveToolCall: false,
        outputLength: opts.content.length,
      });
    }
    deps.socketManager.broadcastAgentMessage(
      {
        type: 'system_info',
        catId: fromCatId,
        content: JSON.stringify({
          type: 'a2a_pingpong_terminated',
          fromCatId,
          targetCatId: plan.stop.catId,
          pairCount: plan.stop.pairCount,
        }),
        timestamp: Date.now(),
      },
      threadId,
    );
  }

  const enqueued: CatId[] = [];
  const coalesced: CatId[] = [];
  const acceptedEntries: QueueEntry[] = [];
  const queueDiagnostics: Array<{ catId: CatId; outcome: string; entryId?: string; createdAt?: number }> = [];
  for (const catId of plan.acceptedTargetCats) {
    if (plan.streakTargetCats.includes(catId) && callerCatId) {
      const worklist = getWorklist(threadId, opts.parentInvocationId);
      if (worklist) {
        updateStreakOnPush(worklist, callerCatId, catId, {
          hadSubstantiveToolCall: false,
          outputLength: opts.content.length,
        });
      }
    }
    const idempotencyKey = opts.actionSuccessorFence
      ? `action:${opts.actionSuccessorFence.leaseId}:${opts.actionSuccessorFence.generation}:${catId}`
      : `a2a:${triggerMessageId}:${catId}`;
    const preAdmittedEntry = opts.preAdmittedEntries?.find(
      (entry) => entry.target.kind === 'cat' && entry.target.catId === catId,
    );
    const result = preAdmittedEntry
      ? {
          outcome: 'enqueued' as const,
          entry: preAdmittedEntry,
          deduped: opts.preAdmittedReplayed === true,
        }
      : await deps.invocationQueue.enqueueDurable({
          from: { kind: 'agent', catId: fromCatId },
          threadId,
          userId: opts.userId,
          kind: 'message_wake',
          ownerAuthProvenance,
          content: opts.content,
          messageId: triggerMessageId,
          sourceId: triggerMessageId,
          sourceCategory: 'a2a',
          targetCats: [catId],
          intent: 'execute',
          autoExecute: true,
          a2aParentInvocationId: opts.parentInvocationId,
          callerTraceContext: ensureDispatchTraceContext(),
          a2aTriggerMessageId: triggerMessageId,
          idempotencyKey,
          ...(opts.actionSuccessorFence ? { actionSuccessorFence: opts.actionSuccessorFence } : {}),
        });
    queueDiagnostics.push({
      catId,
      outcome: result.outcome,
      ...(result.entry ? { entryId: result.entry.id, createdAt: result.entry.enqueuedAt } : {}),
    });
    if (result.outcome !== 'enqueued') continue;
    if (result.deduped) {
      coalesced.push(catId);
      continue;
    }
    if (!result.entry) continue;
    enqueued.push(catId);
    acceptedEntries.push(result.entry);
  }

  opts.onQueueEntriesAdmitted?.(acceptedEntries);
  const handedToCatId = enqueued.length === 1 ? enqueued[0] : undefined;
  if (deps.ballCustody && handedToCatId) {
    try {
      await deps.ballCustody.record(
        buildHandedEvent({
          threadId,
          messageId: triggerMessageId,
          fromCatId,
          toCatId: handedToCatId,
          at: Date.now(),
        }),
      );
    } catch (err) {
      log.warn(
        { err, threadId, triggerMessageId, fromCatId, toCatId: handedToCatId },
        '[F167 Phase T] accepted A2A queue handoff custody write failed (best-effort)',
      );
    }
  }
  if (deps.queueProcessor.tryAutoAppendExactEntry) {
    for (const entry of acceptedEntries) {
      await deps.queueProcessor.tryAutoAppendExactEntry({ threadId, userId: opts.userId, entryId: entry.id });
    }
  }
  if (enqueued.length > 0) {
    await emitQueueUpdated(
      deps.socketManager,
      opts.userId,
      threadId,
      deps.invocationQueue.list(threadId, opts.userId),
      deps.messageStore,
      'enqueued',
    );
  }
  log.info(
    { threadId, triggerMessageId, callerCatId, targetCats, queueDiagnostics, enqueued },
    '[DIAG/a2a] enqueueA2ATargets single-ledger admission',
  );
  await deps.queueProcessor.requestDrain(threadId);
  return { enqueued, ...(coalesced.length > 0 ? { coalesced } : {}) };
}
