import { isDeepStrictEqual } from 'node:util';
import type { RuntimeInteractionRecord, UnifiedAttentionChoiceRequest, UnifiedAttentionItemV1 } from '@cat-cafe/shared';

function decisionRef(record: RuntimeInteractionRecord): string {
  return `f306.runtime_interaction:${record.request.interactionId}`;
}

function projectChoice(record: RuntimeInteractionRecord): UnifiedAttentionChoiceRequest | null {
  if (record.status !== 'pending' || record.request.kind !== 'question' || !record.cardRef) return null;
  return {
    interactionId: record.request.interactionId,
    revision: record.updatedAt,
    requesterCatId: record.request.owner.catId,
    createdAt: record.request.createdAt,
    title: record.request.title,
    questions: record.request.questions,
    cardRef: record.cardRef,
  };
}

function exactNeedsMeWitness(
  item: UnifiedAttentionItemV1,
  record: RuntimeInteractionRecord,
  choice: UnifiedAttentionChoiceRequest,
): boolean {
  const taskRef = record.request.entrustedWorkTaskRef;
  if (!taskRef) return false;
  return item.linkedNeedsMe.some(
    ({ ownerRead, receipt }) =>
      receipt.producer.producerId === 'f306.runtime_interaction' &&
      receipt.producer.subjectRef === choice.interactionId &&
      receipt.producer.revision === choice.revision &&
      receipt.taskRef.subjectRef === taskRef.subjectRef &&
      receipt.taskRef.observedRevision === taskRef.observedRevision &&
      ownerRead.envelope.subjectRef === taskRef.subjectRef &&
      ownerRead.envelope.revision === taskRef.observedRevision,
  );
}

/** Merge canonical pending questions into the existing decision vector without duplicating a Task-linked F306 receipt. */
export function mergeStructuredChoices(
  items: UnifiedAttentionItemV1[],
  records: RuntimeInteractionRecord[],
  reasons: Set<string>,
): UnifiedAttentionItemV1[] {
  for (const record of records) {
    const choice = projectChoice(record);
    if (!choice) continue;
    const ref = decisionRef(record);
    const sameIdentity = items.filter((item) => item.decisionRef === ref);
    const exact = sameIdentity.find((item) => exactNeedsMeWitness(item, record, choice));
    if (exact) {
      if (exact.choiceRequest && !isDeepStrictEqual(exact.choiceRequest, choice)) {
        reasons.add('ambiguous_decision_identity');
        items.push(choiceItem(ref, choice));
      } else {
        exact.choiceRequest = choice;
      }
      continue;
    }
    if (sameIdentity.length > 0) reasons.add('producer_version_or_link_unverified');
    items.push(choiceItem(ref, choice));
  }
  return items;
}

function choiceItem(decisionRefValue: string, choiceRequest: UnifiedAttentionChoiceRequest): UnifiedAttentionItemV1 {
  const onlyQuestion = choiceRequest.questions.length === 1 ? choiceRequest.questions[0] : undefined;
  const summary = onlyQuestion?.question ?? choiceRequest.title;
  return {
    decisionRef: decisionRefValue,
    kind: 'judgment',
    summary,
    choiceRequest,
    linkedNeedsMe: [],
  };
}
