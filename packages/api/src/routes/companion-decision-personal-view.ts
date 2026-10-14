import { createHash } from 'node:crypto';
import {
  type IgnoredItemSnapshot,
  ignoredItemKey,
  type UnifiedAttentionItemV1,
  type UnifiedAttentionPersonalGroupCountsV1,
  type UnifiedAttentionPersonalViewV1,
  type UnifiedAttentionPreferenceCoordinate,
  type UnifiedAttentionSourceRead,
} from '@cat-cafe/shared';
import type { UserMentionTodoRead } from './user-mention-todo-projection.js';

export interface DecisionPersonalViewInput {
  mode: 'visible' | 'ignored';
  snapshot?: IgnoredItemSnapshot;
  state: UnifiedAttentionSourceRead;
}

function decisionQualifiedItems(items: UnifiedAttentionItemV1[]): UnifiedAttentionItemV1[] {
  return items.filter(decisionQualified);
}

function decisionQualified(item: UnifiedAttentionItemV1): boolean {
  return item.approval?.resolution === 'open' || item.choiceRequest !== undefined;
}

function groupCounts(items: UnifiedAttentionItemV1[]): UnifiedAttentionPersonalGroupCountsV1['original'] {
  const counts = { decisions: 0, userMentions: 0, other: 0 };
  for (const item of items) {
    if (item.kind === 'user_mention') counts.userMentions++;
    else if (decisionQualified(item)) counts.decisions++;
    else counts.other++;
  }
  return counts;
}

interface ExactPersonalCounts {
  originalTotalCount: number;
  visibleTotalCount: number;
  ignoredTotalCount: number;
  originalAttentionCount: number;
  visibleAttentionCount: number;
  ignoredAttentionCount: number;
  groupCounts: UnifiedAttentionPersonalGroupCountsV1;
}

interface PersonalProjection {
  pageItems: UnifiedAttentionItemV1[];
  attentionItems: UnifiedAttentionItemV1[];
  sourceExact: boolean;
  view?: UnifiedAttentionPersonalViewV1;
  counts?: ExactPersonalCounts;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function exactVersionPayload(item: UnifiedAttentionItemV1): unknown | null {
  if (item.userMention) {
    if (!Number.isSafeInteger(item.userMention.expectedRevision) || item.userMention.expectedRevision === undefined)
      return null;
    return {
      kind: 'user_mention',
      messageId: item.userMention.messageId,
      expectedRevision: item.userMention.expectedRevision,
    };
  }
  if (item.choiceRequest) {
    return {
      kind: 'structured_choice',
      interactionId: item.choiceRequest.interactionId,
      revision: item.choiceRequest.revision,
      cardRef: item.choiceRequest.cardRef,
    };
  }
  if (item.approval) return { kind: 'approval', approval: item.approval };
  if (item.linkedNeedsMe.length === 0) return null;
  const receipts = item.linkedNeedsMe
    .map(({ ownerRead, receipt }) => ({
      ownerSubjectRef: ownerRead.envelope.subjectRef,
      ownerRevision: ownerRead.envelope.revision,
      producer: receipt.producer,
      taskRef: receipt.taskRef,
      kind: receipt.kind,
      action: receipt.action,
    }))
    .sort((left, right) => canonical(left).localeCompare(canonical(right)));
  return { kind: item.kind, receipts };
}

function preferenceCoordinate(item: UnifiedAttentionItemV1): UnifiedAttentionPreferenceCoordinate | undefined {
  const versionPayload = exactVersionPayload(item);
  if (!versionPayload) return undefined;
  const version = `sha256:${createHash('sha256')
    .update(canonical({ decisionRef: item.decisionRef, version: versionPayload }))
    .digest('hex')}`;
  return { kind: 'mailbox', decisionRef: item.decisionRef, version };
}

export function attachDecisionPreferenceCoordinates(items: UnifiedAttentionItemV1[]): UnifiedAttentionItemV1[] {
  return items.map((item) => {
    const coordinate = preferenceCoordinate(item);
    return coordinate ? { ...item, preferenceCoordinate: coordinate } : item;
  });
}

function snapshotIsExact(
  snapshot: IgnoredItemSnapshot | undefined,
  ownerUserId: string,
): snapshot is IgnoredItemSnapshot {
  return Boolean(
    snapshot &&
      snapshot.ownerUserId === ownerUserId &&
      Number.isSafeInteger(snapshot.revision) &&
      snapshot.revision >= 0,
  );
}

function partition(
  items: UnifiedAttentionItemV1[],
  ignoredKeys: Set<string>,
): { visible: UnifiedAttentionItemV1[]; ignored: UnifiedAttentionItemV1[]; exact: boolean } {
  const visible: UnifiedAttentionItemV1[] = [];
  const ignored: UnifiedAttentionItemV1[] = [];
  let exact = true;
  for (const item of items) {
    if (!item.preferenceCoordinate) {
      exact = false;
      continue;
    }
    (ignoredKeys.has(ignoredItemKey(item.preferenceCoordinate)) ? ignored : visible).push(item);
  }
  return { visible, ignored, exact };
}

/** Personal presentation only: canonical membership and lifecycle stay untouched. */
export function projectDecisionPersonalView(input: {
  pageItems: UnifiedAttentionItemV1[];
  attentionItems: UnifiedAttentionItemV1[];
  ownerUserId: string;
  personal?: DecisionPersonalViewInput;
}): PersonalProjection {
  const pageItems = attachDecisionPreferenceCoordinates(input.pageItems);
  const attentionItems = attachDecisionPreferenceCoordinates(input.attentionItems);
  if (!input.personal) return { pageItems, attentionItems, sourceExact: true };

  const { mode, snapshot, state } = input.personal;
  const baseView: UnifiedAttentionPersonalViewV1 = { mode };
  const sourceExact =
    state.status === 'available' && state.exhaustiveness === 'complete' && snapshotIsExact(snapshot, input.ownerUserId);
  if (!sourceExact) return { pageItems: [], attentionItems: [], sourceExact: false, view: baseView };

  const ignoredKeys = new Set(
    snapshot.entries
      .filter((entry) => entry.coordinate.kind === 'mailbox')
      .map((entry) => ignoredItemKey(entry.coordinate)),
  );
  const page = partition(pageItems, ignoredKeys);
  const attention = partition(attentionItems, ignoredKeys);
  if (!page.exact || !attention.exact) {
    return {
      pageItems: [],
      attentionItems: [],
      sourceExact: false,
      view: { ...baseView, preferenceRevision: snapshot.revision },
    };
  }
  const counts = {
    originalTotalCount: pageItems.length,
    visibleTotalCount: page.visible.length,
    ignoredTotalCount: page.ignored.length,
    originalAttentionCount: attentionItems.length,
    visibleAttentionCount: attention.visible.length,
    ignoredAttentionCount: attention.ignored.length,
    groupCounts: {
      original: groupCounts(pageItems),
      visible: groupCounts(page.visible),
      ignored: groupCounts(page.ignored),
    },
  };
  return {
    pageItems: mode === 'visible' ? page.visible : page.ignored,
    attentionItems: mode === 'visible' ? attention.visible : attention.ignored,
    sourceExact: true,
    view: { mode, preferenceRevision: snapshot.revision },
    counts,
  };
}

export function selectDecisionPersonalItems(input: {
  canonicalItems: UnifiedAttentionItemV1[];
  reasons: Set<string>;
  userMentions?: UserMentionTodoRead;
  userId: string;
  personal?: DecisionPersonalViewInput;
}): PersonalProjection {
  const historicalMentions = input.userMentions?.period === 'earlier' || input.userMentions?.period === 'handled';
  const pageItems = historicalMentions
    ? [...(input.userMentions?.items ?? [])]
    : [...input.canonicalItems, ...(input.userMentions?.items ?? [])];
  const projection = projectDecisionPersonalView({
    pageItems,
    attentionItems: decisionQualifiedItems(input.canonicalItems),
    ownerUserId: input.userId,
    personal: input.personal,
  });
  if (input.personal && !projection.sourceExact) input.reasons.add('personal_preference_read_unverified');
  return projection;
}
