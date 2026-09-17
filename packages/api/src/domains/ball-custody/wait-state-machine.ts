import type {
  AwaitStateV1,
  GitHubWaitMatchedDelta,
  WaitOutcomeV1,
  WaitTerminationActor,
  WaitTerminationReason,
} from '@cat-cafe/shared';
import { parseWaitOwnerFence } from '@cat-cafe/shared';

export interface WaitRuntimeState {
  readonly await?: AwaitStateV1;
  readonly waitOutcome?: WaitOutcomeV1;
}

export type WaitTransitionEvent =
  | {
      readonly type: 'predicates_matched';
      readonly generation: number;
      readonly at: number;
      readonly matched: readonly GitHubWaitMatchedDelta[];
    }
  | {
      readonly type: 'subject_terminal';
      readonly generation: number;
      readonly at: number;
      readonly subjectState: 'merged' | 'closed';
    }
  | {
      readonly type: 'expired' | 'owner_changed' | 'superseded';
      readonly generation: number;
      readonly at: number;
    }
  | {
      readonly type: 'user_cancel';
      readonly generation: number;
      readonly at: number;
      readonly actor: Extract<WaitTerminationActor, { kind: 'user' | 'cat' }>;
    };

export type WaitTransitionResult =
  | { readonly applied: true; readonly state: WaitRuntimeState }
  | {
      readonly applied: false;
      readonly reason: 'generation_inactive' | 'empty_match';
      readonly state: WaitRuntimeState;
    };

function outcomeId(subjectRef: string, generation: number, reason: WaitTerminationReason): string {
  return `wait:${subjectRef}:g${generation}:${reason}`;
}

function terminalize(
  current: WaitRuntimeState,
  active: AwaitStateV1,
  input: {
    readonly reason: WaitTerminationReason;
    readonly at: number;
    readonly actor?: WaitTerminationActor;
    readonly matched?: readonly GitHubWaitMatchedDelta[];
    readonly subjectState?: 'merged' | 'closed';
  },
): WaitTransitionResult {
  const delivery = input.reason === 'matched' || input.reason === 'subject_terminal' ? 'pending' : 'not_applicable';
  const waitOutcome: WaitOutcomeV1 = {
    v: 1,
    outcomeId: outcomeId(active.subjectRef, active.generation, input.reason),
    generation: active.generation,
    subjectRef: active.subjectRef,
    ownerFence: active.ownerFence,
    reason: input.reason,
    at: input.at,
    delivery,
    actor: input.actor ?? { kind: 'system' },
    ...(input.matched?.length ? { matched: input.matched } : {}),
    ...(delivery === 'pending' ? { nextStep: active.continuation.then } : {}),
    ...(input.subjectState ? { terminalSubjectState: input.subjectState } : {}),
  };
  return {
    applied: true,
    state: {
      ...current,
      await: undefined,
      waitOutcome,
    },
  };
}

/**
 * #1474: the two events that carry a fact the clock must not overwrite.
 *
 * A subject that reached its terminal state (issue closed, PR merged) and an owner who explicitly
 * cancelled are the answers the wait existed to deliver. Judging the deadline first rewrote both to
 * `expired` — and `expired` is not a delivered reason, so the owner was never told at all. An
 * ordinary observation still loses to the deadline: expiry must keep winning over a late predicate
 * match, which is a guess about relevance rather than a settled fact.
 */
const TERMINAL_FACT_EVENTS: ReadonlySet<WaitTransitionEvent['type']> = new Set(['subject_terminal', 'user_cancel']);

export function transitionWaitState(current: WaitRuntimeState, event: WaitTransitionEvent): WaitTransitionResult {
  const active = current.await;
  if (!active || active.generation !== event.generation) {
    return { applied: false, reason: 'generation_inactive', state: current };
  }

  if (!TERMINAL_FACT_EVENTS.has(event.type) && event.at >= active.expiresAt) {
    return terminalize(current, active, { reason: 'expired', at: event.at });
  }

  switch (event.type) {
    case 'predicates_matched':
      if (event.matched.length === 0) {
        return { applied: false, reason: 'empty_match', state: current };
      }
      return terminalize(current, active, {
        reason: 'matched',
        at: event.at,
        matched: event.matched,
      });
    case 'subject_terminal':
      return terminalize(current, active, {
        reason: 'subject_terminal',
        at: event.at,
        subjectState: event.subjectState,
      });
    case 'user_cancel':
      return terminalize(current, active, {
        reason: 'user_cancel',
        at: event.at,
        actor: event.actor,
      });
    case 'expired':
    case 'owner_changed':
    case 'superseded':
      return terminalize(current, active, { reason: event.type, at: event.at });
  }
}

export function markWaitOutcomeDelivered(current: WaitRuntimeState, outcomeId: string): WaitRuntimeState {
  if (current.waitOutcome?.outcomeId !== outcomeId || current.waitOutcome.delivery !== 'pending') {
    return current;
  }
  return {
    ...current,
    waitOutcome: {
      ...current.waitOutcome,
      delivery: 'delivered',
    },
  };
}

export function markWaitOutcomeLegacyUnfenced(current: WaitRuntimeState, outcomeId: string): WaitRuntimeState {
  if (
    current.waitOutcome?.outcomeId !== outcomeId ||
    current.waitOutcome.delivery !== 'pending' ||
    parseWaitOwnerFence(current.waitOutcome.ownerFence)
  ) {
    return current;
  }
  return {
    ...current,
    waitOutcome: {
      ...current.waitOutcome,
      delivery: 'legacy_unfenced',
    },
  };
}
