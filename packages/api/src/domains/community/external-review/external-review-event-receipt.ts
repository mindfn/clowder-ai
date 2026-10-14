import type { CommunityEvent, ExternalReviewAggregate } from '@cat-cafe/shared';
import type { ICommunityEventLog } from '../CommunityEventLog.js';
import {
  applyExternalReviewProjectionEvent,
  isExternalReviewEventKind,
  isExternalReviewTerminalEventKind,
} from './external-review-projector.js';
import { ExternalReviewVerdictError } from './external-review-verdict-error.js';

/** Replay the canonical prefix through this exact fact, never re-authorize it against a later assignment. */
export async function loadExternalReviewEventReceipt(
  eventLog: ICommunityEventLog,
  event: CommunityEvent,
): Promise<ExternalReviewAggregate> {
  let aggregate: ExternalReviewAggregate | null = null;
  for (const fact of await eventLog.read(event.subjectKey)) {
    if (!isExternalReviewEventKind(fact.kind) && !isExternalReviewTerminalEventKind(fact.kind)) continue;
    const result = applyExternalReviewProjectionEvent(aggregate, fact);
    if (fact.sourceEventId === event.sourceEventId) {
      if (result.ok) return result.value;
      throw new ExternalReviewVerdictError(
        result.reason === 'invalid_assignment' ? 'wrong_principal' : 'projection_unavailable',
        `Verdict event was not projected at its commit position: ${result.reason}`,
      );
    }
    if (result.ok) aggregate = result.value;
  }
  throw new ExternalReviewVerdictError('projection_unavailable', 'Canonical verdict event missing');
}
