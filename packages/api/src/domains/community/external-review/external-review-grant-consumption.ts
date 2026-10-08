import type { CommunityEvent, ExternalReviewAggregate } from '@cat-cafe/shared';
import {
  applyExternalReviewProjectionEvent,
  isExternalReviewEventKind,
  isExternalReviewTerminalEventKind,
} from './external-review-projector.js';

/** Accepted transfer facts consume the grant; recorded but rejected transitions do not. */
export function consumedReviewerGrant(events: readonly CommunityEvent[], proposalId: string): CommunityEvent | null {
  let aggregate: ExternalReviewAggregate | null = null;
  for (const event of events) {
    if (!isExternalReviewEventKind(event.kind) && !isExternalReviewTerminalEventKind(event.kind)) continue;
    const result = applyExternalReviewProjectionEvent(aggregate, event);
    if (!result.ok) continue;
    aggregate = result.value;
    if (event.kind !== 'case.external_review_reassigned') continue;
    const authority = event.payload.authority;
    if (!authority || typeof authority !== 'object') continue;
    const fields = authority as Record<string, unknown>;
    if (fields.kind === 'approved_proposal' && fields.proposalId === proposalId) return event;
  }
  return null;
}
