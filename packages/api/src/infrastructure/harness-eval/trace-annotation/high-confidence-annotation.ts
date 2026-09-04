import type { TraceAnnotation } from '@cat-cafe/shared';

/** Semantic-sweep history is audit-only and must not steer automation. */
export function isHighConfidenceAnnotation(annotation: TraceAnnotation): boolean {
  return annotation.source === 'structured-rule' || annotation.source === 'mcp-marker';
}

export function isHighConfidenceCounterexample(annotation: TraceAnnotation): boolean {
  return isHighConfidenceAnnotation(annotation) && annotation.polarity === 'counterexample';
}
