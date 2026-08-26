import type {
  AutomationState,
  GitHubIssueWaitBaseline,
  GitHubPrWaitBaseline,
  GitHubWaitPredicate,
  IssueWaitAutomationState,
  PrAutomationState,
  TaskItem,
  WaitOutcomeV1,
  WaitTerminationActor,
  WaitTerminationEventV1,
} from '@cat-cafe/shared';
import { createWaitContinuationCarrier, parseWaitOwnerFence } from '@cat-cafe/shared';
import type {
  ConnectorDeliveryDeps,
  ConnectorDeliveryInput,
} from '../../infrastructure/email/deliver-connector-message.js';
import { deliverConnectorMessage } from '../../infrastructure/email/deliver-connector-message.js';
import type { IWaitLifecycleEventLog } from '../ball-custody/WaitLifecycleEventLog.js';
import {
  markWaitOutcomeDelivered,
  markWaitOutcomeLegacyUnfenced,
  transitionWaitState,
  type WaitTransitionEvent,
} from '../ball-custody/wait-state-machine.js';
import type { ITaskStore } from '../cats/services/stores/ports/TaskStore.js';
import { type GitHubWaitFacts, matchGitHubWaitPredicates } from './GitHubWaitPredicateCatalog.js';
import { renderGitHubWaitOutcome } from './github-wait-renderer.js';

/** Default auto-decay: 30 days in milliseconds. */
const DEFAULT_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;

export interface GitHubCollectorPatch {
  readonly review?: NonNullable<PrAutomationState['review']>;
  readonly ci?: NonNullable<PrAutomationState['ci']>;
  readonly conflict?: NonNullable<PrAutomationState['conflict']>;
  readonly issue?: NonNullable<IssueWaitAutomationState['issue']>;
}

export interface GitHubWaitObservation {
  readonly taskId: string;
  readonly facts: GitHubWaitFacts;
  readonly collectorPatch?: GitHubCollectorPatch;
  readonly subjectState?: 'merged' | 'closed';
  readonly at?: number;
  /** Source-owned, typed metadata for the connector message created by this observation. */
  readonly deliveryExtra?: ConnectorDeliveryInput['extra'];
}

export type GitHubWaitLifecycleResult =
  | { readonly kind: 'not_tracked' | 'state_only' | 'deduped'; readonly reason: string }
  | {
      readonly kind: 'notified';
      readonly task: TaskItem;
      readonly outcome: WaitOutcomeV1;
      readonly messageId: string;
      readonly content: string;
    };

export interface GitHubWaitLifecycleServiceOptions {
  readonly taskStore: ITaskStore;
  readonly deliveryDeps: ConnectorDeliveryDeps;
  readonly eventLog?: IWaitLifecycleEventLog;
  readonly log: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
  readonly now?: () => number;
}

function mergeCollectorState(
  taskKind: TaskItem['kind'],
  state: AutomationState | undefined,
  patch: GitHubCollectorPatch | undefined,
): AutomationState {
  if (taskKind === 'issue_tracking') {
    const issueState = state as IssueWaitAutomationState | undefined;
    return {
      ...(issueState?.issue || patch?.issue ? { issue: { ...issueState?.issue, ...patch?.issue } } : {}),
      ...(issueState?.closedAt !== undefined ? { closedAt: issueState.closedAt } : {}),
      ...(issueState?.await ? { await: issueState.await } : {}),
      ...(issueState?.waitOutcome ? { waitOutcome: issueState.waitOutcome } : {}),
    };
  }
  const prState = state as PrAutomationState | undefined;
  return {
    ...(prState?.review || patch?.review ? { review: { ...prState?.review, ...patch?.review } } : {}),
    ...(prState?.ci || patch?.ci ? { ci: { ...prState?.ci, ...patch?.ci } } : {}),
    ...(prState?.conflict || patch?.conflict ? { conflict: { ...prState?.conflict, ...patch?.conflict } } : {}),
    ...(prState?.closedAt !== undefined ? { closedAt: prState.closedAt } : {}),
    ...(prState?.await ? { await: prState.await } : {}),
    ...(prState?.waitOutcome ? { waitOutcome: prState.waitOutcome } : {}),
  };
}

function lifecycleEvent(task: TaskItem, outcome: WaitOutcomeV1): WaitTerminationEventV1 {
  if (!task.userId || !task.ownerCatId) {
    throw new Error(`GitHub wait ${task.id} has no canonical owner identity`);
  }
  return {
    v: 1,
    eventId: outcome.outcomeId,
    kind: 'wait.terminated',
    waitId: task.id,
    waitKind: task.kind === 'issue_tracking' ? 'github_issue' : 'github_pr',
    subjectRef: outcome.subjectRef,
    threadId: task.threadId,
    ownerUserId: task.userId,
    ownerCatId: task.ownerCatId,
    generation: outcome.generation,
    reason: outcome.reason,
    actor: outcome.actor ?? { kind: 'system' },
    at: outcome.at,
  };
}

function pendingOutcome(task: TaskItem): WaitOutcomeV1 | null {
  const outcome = task.automationState?.waitOutcome;
  return outcome?.delivery === 'pending' ? outcome : null;
}

/** Compute effective expiry: explicit value or default 30 days from creation. */
function effectiveExpiresAt(active: { expiresAt?: number; createdAt: number }): number {
  return active.expiresAt ?? active.createdAt + DEFAULT_EXPIRY_MS;
}

/**
 * Resolve the nextStep for a matched outcome. Per-predicate nextStep overrides
 * the global `then` when the matching predicate has its own action prompt.
 */
function resolveNextStep(
  matched: readonly { readonly kind: string }[],
  predicates: readonly GitHubWaitPredicate[],
  globalThen: string,
): string {
  if (matched.length === 0) return globalThen;
  const firstMatchKind = matched[0].kind;
  const matchedPredicate = predicates.find((p) => p.kind === firstMatchKind);
  return matchedPredicate?.nextStep ?? globalThen;
}

export class GitHubWaitLifecycleService {
  private readonly now: () => number;

  constructor(private readonly opts: GitHubWaitLifecycleServiceOptions) {
    this.now = opts.now ?? Date.now;
  }

  async observe(input: GitHubWaitObservation): Promise<GitHubWaitLifecycleResult> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const task = await this.opts.taskStore.get(input.taskId);
      if (!task || (task.kind !== 'pr_tracking' && task.kind !== 'issue_tracking')) {
        return { kind: 'not_tracked', reason: `No GitHub wait task ${input.taskId}` };
      }

      const existingPending = pendingOutcome(task);
      if (existingPending) return this.publishPending(task, existingPending, input.deliveryExtra);

      const state = task.automationState;
      const active = state?.await;
      const collectorState = mergeCollectorState(task.kind, state, input.collectorPatch);
      if (!active) {
        if (input.subjectState) {
          const installed = await this.opts.taskStore.replaceAutomationStateIfGeneration(task.id, {
            expectedGeneration: null,
            expectedUpdatedAt: task.updatedAt,
            automationState: collectorState,
            status: 'done',
          });
          if (!installed) continue;
          return { kind: 'state_only', reason: 'subject_terminal_without_active_wait' };
        }
        if (input.collectorPatch) {
          await this.opts.taskStore.patchAutomationState(task.id, input.collectorPatch as Partial<AutomationState>);
        }
        return { kind: 'state_only', reason: 'no_active_wait' };
      }

      const at = input.at ?? this.now();
      let transition: WaitTransitionEvent;
      if (input.subjectState) {
        transition = {
          type: 'subject_terminal',
          generation: active.generation,
          at,
          subjectState: input.subjectState,
        };
      } else {
        const matched = matchGitHubWaitPredicates(active.continuation.when, active.baseline, input.facts);
        if (matched.length === 0 && at < effectiveExpiresAt(active)) {
          if (input.collectorPatch) {
            await this.opts.taskStore.patchAutomationState(task.id, input.collectorPatch as Partial<AutomationState>);
          }
          return { kind: 'state_only', reason: 'predicates_not_matched' };
        }
        transition = {
          type: 'predicates_matched',
          generation: active.generation,
          at,
          matched,
        };
      }

      const transitioned = transitionWaitState(collectorState, transition);
      if (!transitioned.applied) {
        return { kind: 'deduped', reason: transitioned.reason };
      }
      const replacement = transitioned.state as AutomationState;
      const installed = await this.opts.taskStore.replaceAutomationStateIfGeneration(task.id, {
        expectedGeneration: active.generation,
        expectedUpdatedAt: task.updatedAt,
        automationState: replacement,
        status: 'done',
      });
      if (!installed) continue;
      const outcome = installed.automationState?.waitOutcome;
      if (!outcome) return { kind: 'state_only', reason: 'terminalized_without_outcome' };
      await this.appendLifecycleEvent(installed, outcome);
      if (outcome.delivery !== 'pending') {
        return { kind: 'state_only', reason: outcome.reason };
      }
      const result = await this.publishPending(installed, outcome, input.deliveryExtra);
      // Auto-renewal: after successful delivery, re-register with fresh baseline
      if (result.kind === 'notified' && active.autoRenew && !outcome.terminalSubjectState) {
        await this.autoRenew(installed, active, input.facts);
      }
      return result;
    }
    return { kind: 'deduped', reason: 'generation_changed_concurrently' };
  }

  async cancel(
    taskId: string,
    actor: Extract<WaitTerminationActor, { kind: 'user' | 'cat' }>,
    at = this.now(),
  ): Promise<GitHubWaitLifecycleResult> {
    return this.terminalizeWithoutFacts(taskId, {
      type: 'user_cancel',
      generation: 0,
      at,
      actor,
    });
  }

  async ownerChanged(taskId: string, at = this.now()): Promise<GitHubWaitLifecycleResult> {
    return this.terminalizeWithoutFacts(taskId, {
      type: 'owner_changed',
      generation: 0,
      at,
    });
  }

  async recoverOutcome(taskId: string): Promise<GitHubWaitLifecycleResult> {
    const task = await this.opts.taskStore.get(taskId);
    if (!task || (task.kind !== 'pr_tracking' && task.kind !== 'issue_tracking')) {
      return { kind: 'not_tracked', reason: 'task_missing' };
    }
    const outcome = task.automationState?.waitOutcome;
    if (!outcome) return { kind: 'state_only', reason: 'nothing_to_recover' };
    await this.appendLifecycleEvent(task, outcome);
    if (outcome.delivery === 'pending') return this.publishPending(task, outcome);
    return { kind: 'state_only', reason: outcome.reason };
  }

  async recordOutcomeEvent(task: TaskItem, outcome: WaitOutcomeV1): Promise<void> {
    await this.appendLifecycleEvent(task, outcome);
  }

  private async terminalizeWithoutFacts(
    taskId: string,
    template: WaitTransitionEvent,
  ): Promise<GitHubWaitLifecycleResult> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const task = await this.opts.taskStore.get(taskId);
      if (!task || (task.kind !== 'pr_tracking' && task.kind !== 'issue_tracking')) {
        return { kind: 'not_tracked', reason: 'task_missing' };
      }
      const state = task.automationState;
      const active = state?.await;
      if (!active) return { kind: 'deduped', reason: 'no_active_wait' };
      const event = { ...template, generation: active.generation } as WaitTransitionEvent;
      const transitioned = transitionWaitState(state, event);
      if (!transitioned.applied) return { kind: 'deduped', reason: transitioned.reason };
      const installed = await this.opts.taskStore.replaceAutomationStateIfGeneration(task.id, {
        expectedGeneration: active.generation,
        expectedUpdatedAt: task.updatedAt,
        automationState: transitioned.state as AutomationState,
        status: 'done',
      });
      if (!installed) continue;
      const outcome = installed.automationState?.waitOutcome;
      if (!outcome) return { kind: 'state_only', reason: 'terminalized_without_outcome' };
      await this.appendLifecycleEvent(installed, outcome);
      return { kind: 'state_only', reason: outcome.reason };
    }
    return { kind: 'deduped', reason: 'generation_changed_concurrently' };
  }

  private async appendLifecycleEvent(task: TaskItem, outcome: WaitOutcomeV1): Promise<void> {
    if (!this.opts.eventLog) return;
    try {
      await this.opts.eventLog.append(lifecycleEvent(task, outcome));
    } catch (error) {
      this.opts.log.warn({ error, taskId: task.id, outcomeId: outcome.outcomeId }, '[F280] wait event append deferred');
    }
  }

  private async publishPending(
    task: TaskItem,
    outcome: WaitOutcomeV1,
    deliveryExtra?: ConnectorDeliveryInput['extra'],
  ): Promise<GitHubWaitLifecycleResult> {
    if (!parseWaitOwnerFence(outcome.ownerFence)) {
      return this.quarantineLegacyUnfencedOutcome(task, outcome);
    }
    const content = renderGitHubWaitOutcome(outcome);
    const waitContinuationCarrier = createWaitContinuationCarrier(task.id, outcome);
    const result = await deliverConnectorMessage(this.opts.deliveryDeps, {
      threadId: task.threadId,
      userId: task.userId ?? '',
      catId: task.ownerCatId ?? '',
      content,
      idempotencyKey: outcome.outcomeId,
      source: {
        connector: 'github-wait',
        label: 'GitHub Wait',
        icon: 'github',
        url: outcome.subjectRef.startsWith('pr:')
          ? `https://github.com/${outcome.subjectRef.slice('pr:'.length).replace('#', '/pull/')}`
          : `https://github.com/${outcome.subjectRef.slice('issue:'.length).replace('#', '/issues/')}`,
        meta: { waitContinuationCarrier },
      },
      ...(deliveryExtra ? { extra: deliveryExtra } : {}),
    });

    const current = await this.opts.taskStore.get(task.id);
    if (current?.automationState?.waitOutcome?.outcomeId === outcome.outcomeId) {
      const marked = markWaitOutcomeDelivered(current.automationState ?? {}, outcome.outcomeId);
      await this.opts.taskStore.replaceAutomationStateIfGeneration(task.id, {
        expectedGeneration: outcome.generation,
        expectedUpdatedAt: current.updatedAt,
        automationState: marked as AutomationState,
        status: 'done',
      });
    }
    this.opts.log.info(
      { taskId: task.id, outcomeId: outcome.outcomeId },
      '[F280] delivered compact GitHub wait outcome',
    );
    return { kind: 'notified', task, outcome, messageId: result.messageId, content };
  }

  private async quarantineLegacyUnfencedOutcome(
    task: TaskItem,
    outcome: WaitOutcomeV1,
  ): Promise<GitHubWaitLifecycleResult> {
    this.opts.log.warn(
      { taskId: task.id, outcomeId: outcome.outcomeId },
      `[F280] quarantined legacy unfenced wait outcome ${task.id}; no continuation was published`,
    );
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = attempt === 0 ? task : await this.opts.taskStore.get(task.id);
      const currentOutcome = current?.automationState?.waitOutcome;
      if (!current || currentOutcome?.outcomeId !== outcome.outcomeId) {
        return { kind: 'deduped', reason: 'outcome_changed_concurrently' };
      }
      if (currentOutcome.delivery !== 'pending') {
        return { kind: 'state_only', reason: currentOutcome.reason };
      }
      if (parseWaitOwnerFence(currentOutcome.ownerFence)) {
        return this.publishPending(current, currentOutcome);
      }
      const marked = markWaitOutcomeLegacyUnfenced(current.automationState as PrAutomationState, outcome.outcomeId);
      const installed = await this.opts.taskStore.replaceAutomationStateIfGeneration(task.id, {
        expectedGeneration: outcome.generation,
        expectedUpdatedAt: current.updatedAt,
        automationState: marked as PrAutomationState,
        status: 'done',
      });
      if (installed) return { kind: 'state_only', reason: 'legacy_unfenced' };
    }
    return { kind: 'deduped', reason: 'generation_changed_concurrently' };
  }

  /**
   * Auto-renewal: after a predicate match is delivered, install a fresh await
   * state with the same predicates and a baseline derived from current facts.
   * This makes tracking persistent across events instead of one-shot.
   */
  private async autoRenew(
    task: TaskItem,
    previousActive: {
      readonly generation: number;
      readonly continuation: { readonly when: readonly GitHubWaitPredicate[]; readonly then: string };
      readonly autoRenew?: boolean;
      readonly baseline: GitHubPrWaitBaseline | GitHubIssueWaitBaseline;
      readonly subjectRef: string;
      readonly ownerFence: { readonly kind: string; readonly generation: number };
    },
    facts: GitHubWaitFacts,
  ): Promise<void> {
    const now = this.now();
    const current = await this.opts.taskStore.get(task.id);
    if (!current) return;

    const currentState = current.automationState;
    // Only renew if there's no NEW active wait (another registration could have happened)
    if (currentState?.await) return;

    const newGeneration = (currentState?.waitOutcome?.generation ?? previousActive.generation) + 1;
    const newBaseline = this.buildRenewalBaseline(task.kind, previousActive.baseline, facts, now);
    if (!newBaseline) {
      this.opts.log.warn({ taskId: task.id }, '[F280] auto-renewal: could not construct renewal baseline');
      return;
    }

    // Build a type-compatible await state. Use type assertion because the
    // predicate array is already correctly typed from the previous active state
    // — it can't mix PR and issue predicates — but TypeScript can't narrow
    // the union through the spread.
    type AwaitState =
      | import('@cat-cafe/shared').GitHubPrAwaitStateV1
      | import('@cat-cafe/shared').GitHubIssueAwaitStateV1;
    const renewedAwait = {
      v: 1 as const,
      generation: newGeneration,
      subjectRef: previousActive.subjectRef,
      ownerFence: { kind: 'containing_task' as const, generation: newGeneration },
      baseline: newBaseline,
      continuation: previousActive.continuation,
      createdAt: now,
      autoRenew: true,
      provenance: 'explicit_registration' as const,
    } as AwaitState;

    const replacement = { ...currentState, await: renewedAwait } as AutomationState;

    const installed = await this.opts.taskStore.replaceAutomationStateIfGeneration(task.id, {
      expectedGeneration: previousActive.generation,
      expectedUpdatedAt: current.updatedAt,
      automationState: replacement,
    });

    if (installed) {
      this.opts.log.info(
        { taskId: task.id, generation: newGeneration },
        '[F280] auto-renewed tracking with fresh baseline',
      );
    }
  }

  /**
   * Construct a renewal baseline from the current facts. The new baseline
   * captures the state at the moment of renewal so the same event doesn't
   * re-trigger immediately.
   */
  private buildRenewalBaseline(
    taskKind: TaskItem['kind'],
    previousBaseline: GitHubPrWaitBaseline | GitHubIssueWaitBaseline,
    facts: GitHubWaitFacts,
    now: number,
  ): GitHubPrWaitBaseline | GitHubIssueWaitBaseline | null {
    if (taskKind === 'issue_tracking' && 'issue' in previousBaseline) {
      const maxCommentId = Math.max(
        previousBaseline.issue.lastCommentCursor,
        ...(facts.issue?.comments ?? []).map((c) => c.id),
      );
      return {
        capturedAt: now,
        issue: {
          lastCommentCursor: maxCommentId,
          state: facts.issue?.state ?? previousBaseline.issue.state,
          authorLogin: previousBaseline.issue.authorLogin,
        },
      };
    }

    if (taskKind === 'pr_tracking' && 'headSha' in previousBaseline) {
      return {
        capturedAt: now,
        headSha: facts.headSha ?? previousBaseline.headSha,
        ...(facts.review || previousBaseline.review
          ? {
              review: {
                inlineCommentCursor: previousBaseline.review?.inlineCommentCursor ?? 0,
                conversationCommentCursor:
                  facts.review?.resultConversationCommentCursor ??
                  previousBaseline.review?.conversationCommentCursor ??
                  0,
                decisionCursor: facts.review?.decisionCursor ?? previousBaseline.review?.decisionCursor ?? 0,
                ...(facts.review?.decision ? { decision: facts.review.decision } : {}),
                ...(previousBaseline.review?.threads
                  ? { threads: facts.review?.threads ?? previousBaseline.review.threads }
                  : {}),
              },
            }
          : {}),
        ...(facts.ci || previousBaseline.ci
          ? {
              ci: {
                bucket: facts.ci?.bucket ?? previousBaseline.ci?.bucket ?? 'pending',
                fingerprint: facts.ci?.fingerprint ?? previousBaseline.ci?.fingerprint ?? '',
              },
            }
          : {}),
        ...(facts.conflict || previousBaseline.conflict
          ? {
              conflict: {
                mergeState: facts.conflict?.mergeState ?? previousBaseline.conflict?.mergeState ?? 'UNKNOWN',
              },
            }
          : {}),
      };
    }

    return null;
  }
}
