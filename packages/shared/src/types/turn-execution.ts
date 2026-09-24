import type { CatId } from './ids.js';

export type TurnExecutionKind = 'ordinary' | 'routing_guard';
export type TurnExecutionStatus = 'running' | 'succeeded' | 'failed' | 'canceled' | 'interrupted';
export type TurnExecutionTerminalStatus = Exclude<TurnExecutionStatus, 'running'>;

export interface TurnExecutionCausalRefs {
  triggerMessageId?: string;
  routingGuardReason?: 'missing_routing_exit';
  /** Exact persisted message bodies present in this child's prompt. */
  coveredMessageIds?: string[];
}

/**
 * F117 KD-21: whether anyone but the child's own route commit may publish its streamed output.
 * A child of an action-fenced dispatch is created `gated`: settlement (stop, restart, zombie
 * reclaim, a thrown execution) keeps its draft unpublished until the fence has `allowed` it, and a
 * `rejected` output is never published. The verdict only moves forward: gated → allowed → rejected.
 * A child without this field is not fenced.
 */
export type TurnOutputFence = 'gated' | 'allowed' | 'rejected';
export type TurnOutputFenceVerdict = Exclude<TurnOutputFence, 'gated'>;

export interface CreateTurnExecutionInput {
  invocationId: string;
  parentInvocationId: string;
  threadId: string;
  userId: string;
  catId: CatId;
  executionKind: TurnExecutionKind;
  startedAt: number;
  causal?: TurnExecutionCausalRefs;
  /** Late-bound state outside the immutable identity; a child is only ever created `gated`. */
  outputFence?: TurnOutputFence;
}

export interface TurnExecutionRecord extends CreateTurnExecutionInput {
  status: TurnExecutionStatus;
  endedAt?: number;
  terminalReason?: string;
}

/** Immutable child identity safe to persist beside a visible message body. */
export interface TurnExecutionMessageProjection {
  invocationId: string;
  parentInvocationId: string;
  executionKind: TurnExecutionKind;
}

export interface TurnExecutionTerminalInput {
  status: TurnExecutionTerminalStatus;
  endedAt: number;
  terminalReason?: string;
}

export type CreateTurnExecutionOutcome = 'created' | 'replayed' | 'conflict';

export interface CreateTurnExecutionResult {
  outcome: CreateTurnExecutionOutcome;
  record: TurnExecutionRecord;
}

export type TransitionTurnExecutionOutcome = 'transitioned' | 'already_terminal' | 'not_found';

export interface TransitionTurnExecutionResult {
  outcome: TransitionTurnExecutionOutcome;
  record: TurnExecutionRecord | null;
}

export interface InterruptRunningTurnExecutionsInput {
  endedAt: number;
  terminalReason: string;
  /** Exact children with a presently live external process owner. */
  excludedInvocationIds?: string[];
}
