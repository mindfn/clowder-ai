/**
 * F257 V2 — skip-reason escalation eligibility registry.
 *
 * Sol verdict `2026-07-21-harness-ledger-dedup-active-false-escalation-c3`:
 * `checkGuardThreshold` counted ALL `a2a_route_decision_skip` episodes
 * toward 3/7d harmful-rejection escalation, but `dedup_active` is a
 * HEALTHY delivery-dedup mechanism (cat already processing, skip is
 * correct behavior). Escalating it misclassifies normal operation as harm.
 *
 * This registry declares which skip reasons are ELIGIBLE for harmful-
 * rejection escalation. Classification authority belongs to the PRODUCER
 * (`routing-decision.ts` defines the reason enum), not the escalation
 * layer — Fable architecture ruling.
 *
 * Design: declarative data (not control flow), same pattern as
 * `guard-ledger-registry.ts`. Null-prototype + deep-frozen for immutability.
 *
 * [宪宪/claude-opus-4-6🐾]
 */

// ---------------------------------------------------------------------------
// Skip-reason classification
// ---------------------------------------------------------------------------

/**
 * Category for observability — what kind of skip this is.
 * - 'delivery_dedup': healthy re-delivery suppression (cat already active)
 * - 'safety_guard': harmful pattern blocked (pingpong, depth loops)
 * - 'abort': user/system-initiated abort
 */
export type SkipReasonCategory = 'delivery_dedup' | 'safety_guard' | 'abort';

export interface SkipReasonEntry {
  /** Whether this reason counts toward harmful-rejection escalation. */
  readonly eligible: boolean;
  /** Observability classification. */
  readonly category: SkipReasonCategory;
  /** Human-readable explanation for verdict/bundle attribution. */
  readonly description: string;
}

/**
 * Producer-defined skip reasons that are actually emitted in production.
 *
 * Source of truth: `routing-decision.ts` — the closed union of skip reasons.
 * `queue_pending` exists in the union type but has ZERO production emit
 * points (queuedMessagesPending returns `defer_queue` action, not `skip`).
 * Only reasons with confirmed emit points are registered — dead letters
 * would create false documentation.
 *
 * `pingpong_streak` is a synthetic reason emitted by route-serial when
 * `block_pingpong` action fires (separate guardId `a2a_block_pingpong`).
 *
 * Sol R1 P2-2: classifications must match actual producer semantics.
 * Sol R1 P3-1: entries deep-frozen (shallow freeze lets JS mutate values).
 */
const entries: Record<string, SkipReasonEntry> = Object.assign(Object.create(null) as Record<string, SkipReasonEntry>, {
  dedup_active: Object.freeze({
    eligible: false,
    category: 'delivery_dedup' as const,
    description: 'Cat already processing in InvocationQueue — skip is correct delivery dedup, not a harmful rejection.',
  }),
  depth: Object.freeze({
    eligible: true,
    category: 'safety_guard' as const,
    description: 'A2A chain depth limit reached — may indicate runaway mention loops (chain safety guard).',
  }),
  aborted: Object.freeze({
    eligible: false,
    category: 'abort' as const,
    description: 'User or system abort — intentional cancellation, not a guard rejection.',
  }),
  pingpong_streak: Object.freeze({
    eligible: true,
    category: 'safety_guard' as const,
    description: 'A2A pingpong streak blocked — harmful bidirectional loop.',
  }),
});

export const SKIP_REASON_ELIGIBILITY: Readonly<Record<string, SkipReasonEntry>> = Object.freeze(entries);

// ---------------------------------------------------------------------------
// Query API
// ---------------------------------------------------------------------------

/**
 * Is a skip reason eligible for harmful-rejection escalation?
 *
 * Unknown reasons default to ELIGIBLE (fail-closed: a new reason that
 * nobody classified yet should still escalate — false positive is safer
 * than silent suppression of a new harmful pattern).
 */
export function isEscalationEligible(normalizedReason: string | undefined): boolean {
  if (!normalizedReason) return true; // missing reason → eligible (fail-closed)
  const entry = Object.hasOwn(SKIP_REASON_ELIGIBILITY, normalizedReason)
    ? SKIP_REASON_ELIGIBILITY[normalizedReason]
    : undefined;
  return entry ? entry.eligible : true; // unknown reason → eligible (fail-closed)
}

/**
 * Get the category for a skip reason (observability / bundle breakdown).
 * Returns 'unknown' for unregistered reasons.
 */
export function skipReasonCategory(normalizedReason: string): SkipReasonCategory | 'unknown' {
  const entry = Object.hasOwn(SKIP_REASON_ELIGIBILITY, normalizedReason)
    ? SKIP_REASON_ELIGIBILITY[normalizedReason]
    : undefined;
  return entry ? entry.category : 'unknown';
}
