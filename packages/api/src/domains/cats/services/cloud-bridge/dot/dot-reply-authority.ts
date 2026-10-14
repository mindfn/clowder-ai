import { createCatId } from '@cat-cafe/shared';
import type { IMessageStore, StoredMessage } from '../../stores/ports/MessageStore.js';
import { canViewMessage, isTimelinePublished } from '../../stores/visibility.js';
import { DOT_CAT_ID, type DotConnectionState } from './dot-connection-state.js';

export type DotReplyCandidate = Pick<StoredMessage, 'userId' | 'threadId' | 'catId' | 'replyTo' | 'extra'>;

/** A reply relation is server-stamped causal origin, never caller-provided replyTo alone. */
export async function dotReplyRequest(source: DotReplyCandidate, messages: Pick<IMessageStore, 'getById'>) {
  const rootId = source.extra?.causal?.triggerMessageId;
  const root = rootId ? await messages.getById(rootId) : null;
  return root?.extra?.dotAsk &&
    root.catId === DOT_CAT_ID &&
    source.userId === root.userId &&
    source.threadId === root.threadId &&
    source.catId &&
    root.extra.dotAsk.recipientCatIds.includes(source.catId) &&
    (source.replyTo === undefined || source.replyTo === root.id)
    ? root
    : null;
}

export async function dotReplyAuthority(
  state: DotConnectionState,
  source: DotReplyCandidate,
  messages: Pick<IMessageStore, 'getById'>,
): Promise<'request_reply' | 'ordinary' | 'rejected'> {
  if (!source.catId) return 'ordinary';
  const rootId = source.extra?.causal?.triggerMessageId;
  const parent = rootId ? await messages.getById(rootId) : null;
  // An explicit reply to a dot request without its execution origin cannot mint a return capability.
  const explicitParent = source.replyTo ? await messages.getById(source.replyTo) : null;
  if (explicitParent?.extra?.dotAsk && explicitParent.id !== parent?.id) return 'rejected';
  if (!parent?.extra?.dotAsk) return explicitParent?.extra?.dotAsk ? 'rejected' : 'ordinary';
  const ask = parent.extra.dotAsk;
  const target = source.catId;
  const custody = parent.queueCustody;
  if (target && custody) {
    if (custody.withdrawnByCatIds?.includes(target)) return 'rejected';
    // Queue's accepted replacement/current prompt witness supersedes an older
    // child even if that child later posts a formally authored answer.
    const currentChild =
      custody.steeredInvocationIdByCatId?.[target] ??
      custody.awakenedInvocationIdByCatId?.[target] ??
      custody.seenInvocationIdByCatId?.[target] ??
      custody.targetOutcomeByCatId?.[target]?.invocationId;
    const replyChild = source.extra?.turnExecution?.invocationId ?? source.extra?.stream?.turnInvocationId;
    if (currentChild && currentChild !== replyChild) return 'rejected';
  }

  return parent.catId === DOT_CAT_ID &&
    !parent.deletedAt &&
    !parent.recall &&
    !parent._tombstone &&
    isTimelinePublished(parent) &&
    canViewMessage(parent, { type: 'cat', catId: createCatId(DOT_CAT_ID) }) &&
    parent.visibility !== 'whisper' &&
    parent.threadId === source.threadId &&
    parent.userId === state.ownerUserId &&
    source.userId === state.ownerUserId &&
    ask.ownerUserId === state.ownerUserId &&
    ask.attemptId === state.attemptId &&
    ask.subscriptionId === state.subscription?.id &&
    state.pairedAt !== null &&
    !!state.subscription &&
    (state.subscription.expiresAt === null || state.subscription.expiresAt > Date.now()) &&
    !!source.catId &&
    source.catId !== DOT_CAT_ID &&
    ask.recipientCatIds.includes(source.catId) &&
    (source.replyTo === undefined || source.replyTo === parent.id)
    ? 'request_reply'
    : 'rejected';
}

export async function canDeliverDotSource(
  state: DotConnectionState,
  source: DotReplyCandidate,
  messages: Pick<IMessageStore, 'getById'>,
  allowedCatIds: readonly string[],
) {
  const permission = await dotReplyAuthority(state, source, messages);
  return (
    permission === 'request_reply' ||
    (permission === 'ordinary' && (!source.catId || allowedCatIds.includes(source.catId)))
  );
}
