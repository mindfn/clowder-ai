import type { UnifiedAttentionItemV1 } from '@cat-cafe/shared';

export function decisionQualifiedItems(items: UnifiedAttentionItemV1[]): UnifiedAttentionItemV1[] {
  return items.filter(decisionQualified);
}

export function decisionQualified(item: UnifiedAttentionItemV1): boolean {
  return (
    item.approval?.resolution === 'open' ||
    item.runtimeInteraction !== undefined ||
    item.choiceRequest !== undefined ||
    exactContentReviewDecision(item)
  );
}

function exactContentReviewDecision(item: UnifiedAttentionItemV1): boolean {
  if (item.kind !== 'judgment') return false;
  return item.linkedNeedsMe.some(({ ownerRead, receipt }) => {
    const { producer, taskRef, action } = receipt;
    const ownerRef = `content-review:${producer.subjectRef}`;
    return Boolean(
      receipt.eligible &&
        receipt.kind === 'judgment' &&
        producer.producerId === 'f309.content_review' &&
        producer.ownerRef === ownerRef &&
        Number.isInteger(producer.revision) &&
        producer.revision > 0 &&
        receipt.reasonCode === 'content_review_requested' &&
        action?.actionRef === ownerRef &&
        action.expectedProducerRevision === producer.revision &&
        receipt.reEvaluateActionRef === `${ownerRef}#reevaluate` &&
        taskRef.subjectRef === ownerRead.envelope.subjectRef &&
        taskRef.observedRevision === ownerRead.envelope.revision &&
        ownerRead.envelope.freshness?.state === 'current' &&
        ownerRead.envelope.freshness.observedRevision === ownerRead.envelope.revision,
    );
  });
}
