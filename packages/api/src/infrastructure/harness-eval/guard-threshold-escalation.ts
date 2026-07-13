/**
 * F257 sub-item 2: Guard threshold escalation — immediate eval trigger.
 *
 * When a guard accumulates ≥ ESCALATION_THRESHOLD events within
 * ESCALATION_WINDOW_DAYS, triggers an immediate eval:harness-ledger
 * invocation instead of waiting for the weekly cron ceiling.
 *
 * Design decisions:
 * - **Event-driven**: hooks into GuardRejectionEventLog.postAppendHook —
 *   fires on every event append, not on a polling interval.
 * - **Dedup via Redis**: a per-guard escalation key with TTL prevents
 *   re-triggering on the 4th, 5th, … event in the same window.
 * - **Fail-open**: escalation failures never affect the business path
 *   (the hook is already wrapped in try/catch in the event log).
 * - **Reuses manual trigger path**: calls handleTriggerNow() to produce
 *   snapshot → deliver → invoke eval cat (single invocation path, no drift).
 */

import type { RedisClient } from '@cat-cafe/shared/utils';
import type { GuardRejectionEvent, GuardRejectionEventLog } from './GuardRejectionEventLog.js';
import type { TriggerNowInput } from './manual-trigger/trigger-now.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum events for a single guard to trigger immediate eval. */
export const ESCALATION_THRESHOLD = 3;

/** Window in days over which events are counted toward the threshold. */
export const ESCALATION_WINDOW_DAYS = 7;

/** Redis key prefix for per-guard escalation dedup. */
const DEDUP_KEY_PREFIX = 'guard-rejection:escalated:';

/** Dedup TTL matches the escalation window so keys auto-expire. */
const DEDUP_TTL_SECONDS = ESCALATION_WINDOW_DAYS * 24 * 3600;

// ---------------------------------------------------------------------------
// Escalation result (for testing / observability)
// ---------------------------------------------------------------------------

export interface EscalationCheckResult {
  checked: true;
  guardId: string;
  count: number;
  thresholdMet: boolean;
  alreadyEscalated: boolean;
  escalated: boolean;
  triggerResult?: unknown;
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface GuardThresholdEscalationDeps {
  redis: RedisClient;
  guardRejectionLog: GuardRejectionEventLog;
  /**
   * Trigger function — typically a partial application of handleTriggerNow
   * with all deps pre-bound. Returns the raw result for observability.
   */
  triggerEval: (input: TriggerNowInput) => Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Core function
// ---------------------------------------------------------------------------

/**
 * Check whether a guard has crossed the escalation threshold and, if so,
 * trigger an immediate eval:harness-ledger invocation.
 *
 * Deduplication: a Redis key `guard-rejection:escalated:<guardId>` with
 * TTL = ESCALATION_WINDOW_DAYS prevents re-escalation on subsequent events
 * from the same guard within the same window.
 *
 * @returns Result indicating what happened (for tests/observability).
 */
export async function checkGuardThreshold(
  event: GuardRejectionEvent,
  deps: GuardThresholdEscalationDeps,
): Promise<EscalationCheckResult> {
  const { guardId } = event;
  const windowMs = ESCALATION_WINDOW_DAYS * 24 * 3600 * 1000;
  const since = event.timestamp - windowMs;

  // Step 1: count events for this guard in the window.
  // +1 because countByGuard→queryWindow uses half-open [since, until) interval
  // (upperBound = until - 1). Without +1 the just-appended event at event.timestamp
  // is excluded and the threshold fires one event late (4 instead of 3).
  const count = await deps.guardRejectionLog.countByGuard(guardId, since, event.timestamp + 1);
  if (count < ESCALATION_THRESHOLD) {
    return { checked: true, guardId, count, thresholdMet: false, alreadyEscalated: false, escalated: false };
  }

  // Step 2: atomic claim via SET NX EX — only one concurrent caller wins.
  // Pattern: ApiInstanceLease / RedisDeliveryDedup / RedisProposalStore (codebase prior art).
  // NX = set-if-not-exists; EX = TTL in seconds (matches ESCALATION_WINDOW_DAYS).
  // Atomicity eliminates the GET→SET→EXPIRE race where two fire-and-forget
  // appends both read empty and both trigger.
  const dedupKey = `${DEDUP_KEY_PREFIX}${guardId}`;
  const claimValue = JSON.stringify({ escalatedAt: event.timestamp, count, triggeredBy: event.eventId });
  const claimed = await deps.redis.set(dedupKey, claimValue, 'EX', DEDUP_TTL_SECONDS, 'NX');
  if (claimed !== 'OK') {
    // Another concurrent caller already claimed — dedup.
    return { checked: true, guardId, count, thresholdMet: true, alreadyEscalated: true, escalated: false };
  }

  // Step 3: trigger eval:harness-ledger via the manual trigger path.
  const triggerResult = await deps.triggerEval({
    domainId: 'eval:harness-ledger',
    userId: `threshold-escalation:${guardId}`,
  });

  return {
    checked: true,
    guardId,
    count,
    thresholdMet: true,
    alreadyEscalated: false,
    escalated: true,
    triggerResult,
  };
}

// ---------------------------------------------------------------------------
// Hook factory — creates the postAppendHook for GuardRejectionEventLog
// ---------------------------------------------------------------------------

/**
 * Create a post-append hook that checks guard thresholds on every event.
 * Wire this into GuardRejectionEventLog.setPostAppendHook() at bootstrap.
 *
 * The hook is fire-and-forget: starts the async check but doesn't await it
 * (the event log's append path must not block on escalation).
 */
export function createThresholdEscalationHook(
  deps: GuardThresholdEscalationDeps,
): (event: GuardRejectionEvent) => void {
  return (event: GuardRejectionEvent) => {
    // Fire-and-forget — errors are swallowed by the event log's try/catch.
    void checkGuardThreshold(event, deps).catch(() => {});
  };
}
