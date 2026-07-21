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
 * `guard-ledger-registry.ts`. Null-prototype + frozen for prototype safety.
 *
 * [宪宪/claude-opus-4-6🐾]
 */

// ---------------------------------------------------------------------------
// Skip-reason classification
// ---------------------------------------------------------------------------

/**
 * Category for observability — what kind of skip this is.
 * - 'delivery_dedup': healthy re-delivery suppression (cat already active)
 * - 'safety_guard': harmful pattern blocked (pingpong, abuse)
 * - 'capacity_limit': system capacity reached (depth, queue)
 * - 'abort': user/system-initiated abort
 */
export type SkipReasonCategory = 'delivery_dedup' | 'safety_guard' | 'capacity_limit' | 'abort';

export interface SkipReasonEntry {
  /** Whether this reason counts toward harmful-rejection escalation. */
  eligible: boolean;
  /** Observability classification. */
  category: SkipReasonCategory;
  /** Human-readable explanation for verdict/bundle attribution. */
  description: string;
}

/**
 * Declarative skip-reason → eligibility mapping.
 *
 * Source of truth: `routing-decision.ts` line 28 defines the closed union:
 *   'depth' | 'dedup_active' | 'aborted' | 'queue_pending'
 * Plus the synthetic 'pingpong_streak' emitted directly by route-serial.
 *
 * Null-prototype + frozen (sol P1-3 pattern from guard-ledger-registry).
 */
export const SKIP_REASON_ELIGIBILITY: Readonly<Record<string, SkipReasonEntry>> = Object.freeze(
  Object.assign(Object.create(null) as Record<string, SkipReasonEntry>, {
    dedup_active: {
      eligible: false,
      category: 'delivery_dedup' as const,
      description:
        'Cat already processing in InvocationQueue — skip is correct delivery dedup, not a harmful rejection.',
    },
    depth: {
      eligible: true,
      category: 'capacity_limit' as const,
      description: 'A2A chain depth limit reached — may indicate runaway mention loops.',
    },
    aborted: {
      eligible: false,
      category: 'abort' as const,
      description: 'User or system abort — intentional cancellation, not a guard rejection.',
    },
    queue_pending: {
      eligible: true,
      category: 'capacity_limit' as const,
      description: 'Queue capacity reached while cat is pending — legitimate capacity signal.',
    },
    pingpong_streak: {
      eligible: true,
      category: 'safety_guard' as const,
      description: 'A2A pingpong streak blocked — harmful bidirectional loop.',
    },
  }),
);

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
