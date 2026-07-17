/**
 * F257 V1 — RoutingAttemptDraft types + collector.
 *
 * Semantics single source of truth: T-A decision table (§3.4) in
 * docs/features/assets/F257/objective-driven-redesign-v1.md.
 * This module encodes the table's columns as code and intentionally does NOT
 * restate their definitions (§0 doc-architecture rule). attemptId =
 * (messageId, parserMode, tokenOrdinal) is finalized by the persistence layer
 * after MessageStore assigns messageId — never re-tokenized outside the parser.
 */

import type { CatId } from '@cat-cafe/shared';

export const ROUTING_PARSER_MODES = ['a2a', 'user'] as const;
export type RoutingParserMode = (typeof ROUTING_PARSER_MODES)[number];

export const ROUTING_ATTEMPT_OUTCOMES = [
  'resolved',
  'disabled_cat',
  'self_excluded',
  'unknown_token',
  'duplicate',
  'group_keyword_skip',
  'domain_suffixed_skip',
] as const;
export type RoutingAttemptOutcome = (typeof ROUTING_ATTEMPT_OUTCOMES)[number];

/** Coordinate basis of the spans in a batch (the parser's scan text). */
export const ROUTING_SPAN_BASES = ['a2a_normalized', 'lowercased_message'] as const;
export type RoutingSpanBasis = (typeof ROUTING_SPAN_BASES)[number];

export interface RoutingTokenSpan {
  readonly start: number;
  readonly end: number;
}

export interface RoutingAttemptDraft {
  /** 0-based; assigned once in finalize() after all scan passes merge (T-A §3.4 header). */
  readonly tokenOrdinal: number;
  readonly outcome: RoutingAttemptOutcome;
  /** Raw token text as scanned, e.g. "@opus". */
  readonly token: string;
  readonly span: RoutingTokenSpan;
  readonly targetCatId?: CatId;
}

export interface RoutingAttemptBatch {
  readonly parserMode: RoutingParserMode;
  readonly spanBasis: RoutingSpanBasis;
  readonly attempts: readonly RoutingAttemptDraft[];
  /** T-A (右截断) row: true only when the read-only scan confirmed extra metric-affecting tokens. */
  readonly truncated: boolean;
  readonly metricEligible: boolean;
}

/**
 * Full structural validation of a persisted batch (sol R1 P1-3): a hydrated
 * authority fact that fails ANY field check must be treated as malformed by
 * consumers — partial counting from a half-valid batch biases the metric.
 * Lives next to the type so schema and validator cannot drift.
 */
export function isValidRoutingAttemptBatch(value: unknown): value is RoutingAttemptBatch {
  if (!value || typeof value !== 'object') return false;
  const batch = value as Record<string, unknown>;
  if (!(ROUTING_PARSER_MODES as readonly string[]).includes(batch.parserMode as string)) return false;
  if (!(ROUTING_SPAN_BASES as readonly string[]).includes(batch.spanBasis as string)) return false;
  if (typeof batch.truncated !== 'boolean' || typeof batch.metricEligible !== 'boolean') return false;
  if (!Array.isArray(batch.attempts)) return false;
  return batch.attempts.every((attempt) => isValidRoutingAttemptDraft(attempt));
}

function isValidRoutingAttemptDraft(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const draft = value as Record<string, unknown>;
  if (!Number.isInteger(draft.tokenOrdinal) || (draft.tokenOrdinal as number) < 0) return false;
  if (!(ROUTING_ATTEMPT_OUTCOMES as readonly string[]).includes(draft.outcome as string)) return false;
  if (typeof draft.token !== 'string' || draft.token.length === 0) return false;
  const span = draft.span as Record<string, unknown> | undefined;
  if (!span || typeof span !== 'object') return false;
  if (!Number.isInteger(span.start) || !Number.isInteger(span.end)) return false;
  if ((span.start as number) < 0 || (span.end as number) <= (span.start as number)) return false;
  if (draft.targetCatId !== undefined && typeof draft.targetCatId !== 'string') return false;
  return true;
}

/** T-A eligible column (进分母). */
export function isMetricEligibleOutcome(outcome: RoutingAttemptOutcome): boolean {
  return (
    outcome === 'resolved' || outcome === 'disabled_cat' || outcome === 'self_excluded' || outcome === 'unknown_token'
  );
}

/** T-A success column. */
export function isSuccessOutcome(outcome: RoutingAttemptOutcome): boolean {
  return outcome === 'resolved';
}

interface PendingRoutingDraft {
  readonly outcome: RoutingAttemptOutcome;
  readonly token: string;
  readonly span: RoutingTokenSpan;
  readonly targetCatId?: CatId;
}

/**
 * Collects drafts across scan passes with span-level dedup: a span visited a
 * second time is a traversal artifact and merges silently — the first outcome
 * wins and no new draft is produced (T-A attempt-stream uniqueness contract).
 */
export class RoutingAttemptCollector {
  private readonly drafts: PendingRoutingDraft[] = [];
  private readonly seenSpans = new Set<string>();

  add(span: RoutingTokenSpan, token: string, outcome: RoutingAttemptOutcome, targetCatId?: CatId): void {
    const key = `${span.start}:${span.end}`;
    if (this.seenSpans.has(key)) return;
    this.seenSpans.add(key);
    this.drafts.push(targetCatId === undefined ? { outcome, token, span } : { outcome, token, span, targetCatId });
  }

  finalize(
    parserMode: RoutingParserMode,
    spanBasis: RoutingSpanBasis,
    opts?: { truncated?: boolean },
  ): RoutingAttemptBatch {
    const truncated = opts?.truncated ?? false;
    const attempts = [...this.drafts]
      .sort((a, b) => a.span.start - b.span.start || a.span.end - b.span.end)
      .map((draft, index) => ({ ...draft, tokenOrdinal: index }));
    return { parserMode, spanBasis, attempts, truncated, metricEligible: !truncated };
  }
}
