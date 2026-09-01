'use client';

import type { LifecycleActiveRun, LifecycleDispatchRef, LifecycleStoredMessageMetadata } from '@cat-cafe/shared';
import type { ChatMessage } from '@/stores/chat-types';
import { CatAvatar } from './CatAvatar';

export interface MessageDispatchAvatarProjection {
  targetId: string;
  phase: 'processing' | 'settled';
  statusMessageId: string;
}

const TERMINAL_RESPONSE_STATUSES = new Set(['completed', 'failed', 'canceled', 'interrupted']);

function exactMessageById(messages: readonly ChatMessage[], messageId: string): ChatMessage | undefined {
  const matches = messages.filter((candidate) => candidate.id === messageId);
  return matches.length === 1 ? matches[0] : undefined;
}

function exactActiveRun(
  activeRuns: readonly LifecycleActiveRun[],
  input: {
    sourceMessageId: string;
    targetId: string;
    statusMessageId: string;
    invocationId: string;
  },
): boolean {
  return (
    activeRuns.filter(
      (run) =>
        run.targetId === input.targetId &&
        run.responseMessageId === input.statusMessageId &&
        run.invocationId === input.invocationId &&
        run.inputMessageIds.includes(input.sourceMessageId),
    ).length === 1
  );
}

type StatusDispatchRef = Exclude<LifecycleDispatchRef, { readonly phase: 'assigned' }>;

function settledProjection(ref: StatusDispatchRef): MessageDispatchAvatarProjection {
  return { targetId: ref.targetId, phase: 'settled', statusMessageId: ref.statusMessageId };
}

function projectDispatchRef(
  sourceMessageId: string,
  ref: LifecycleDispatchRef,
  statusLifecycle: LifecycleStoredMessageMetadata,
  activeRuns: readonly LifecycleActiveRun[],
): MessageDispatchAvatarProjection | null {
  if (ref.phase === 'assigned') return null;
  if (statusLifecycle.kind === 'delivery_failure') {
    const exactFailure =
      ref.phase === 'settled' &&
      statusLifecycle.inputMessageId === sourceMessageId &&
      statusLifecycle.requestedTargets.includes(ref.targetId);
    return exactFailure ? settledProjection(ref) : null;
  }
  if (
    statusLifecycle.kind !== 'response' ||
    statusLifecycle.targetId !== ref.targetId ||
    !statusLifecycle.inputMessageIds.includes(sourceMessageId)
  ) {
    return null;
  }
  if (ref.phase === 'settled') {
    return TERMINAL_RESPONSE_STATUSES.has(statusLifecycle.status) ? settledProjection(ref) : null;
  }
  if (statusLifecycle.status !== 'processing') return null;
  return exactActiveRun(activeRuns, {
    sourceMessageId,
    targetId: ref.targetId,
    statusMessageId: ref.statusMessageId,
    invocationId: statusLifecycle.invocationId,
  })
    ? { targetId: ref.targetId, phase: 'processing', statusMessageId: ref.statusMessageId }
    : null;
}

/**
 * The only live dispatch projection. It consumes exact source/ref/response/run
 * identities and fails closed whenever those records disagree or are ambiguous.
 */
export function projectMessageDispatchAvatars(
  message: ChatMessage,
  timelineMessages: readonly ChatMessage[],
  activeRuns: readonly LifecycleActiveRun[],
): MessageDispatchAvatarProjection[] {
  const refs = message.lifecycle?.dispatchRefs ?? [];
  const targetCounts = new Map<string, number>();
  for (const ref of refs) targetCounts.set(ref.targetId, (targetCounts.get(ref.targetId) ?? 0) + 1);

  return refs.flatMap((ref): MessageDispatchAvatarProjection[] => {
    if (ref.phase === 'assigned' || targetCounts.get(ref.targetId) !== 1) return [];
    const statusMessage = exactMessageById(timelineMessages, ref.statusMessageId);
    const statusLifecycle = statusMessage?.lifecycle;
    if (!statusLifecycle) return [];
    const projection = projectDispatchRef(message.id, ref, statusLifecycle, activeRuns);
    return projection ? [projection] : [];
  });
}

/** A delivery-failure row linked from a source is an internal settlement carrier. */
export function isLinkedDeliveryFailureCarrier(
  message: ChatMessage,
  timelineMessages: readonly ChatMessage[],
): boolean {
  const lifecycle = message.lifecycle;
  if (lifecycle?.kind !== 'delivery_failure') return false;
  // A targetless origin failure has no source/member settlement to absorb it.
  // It is the canonical user-visible "唤起处理成员失败" system row.
  if (lifecycle.requestedTargets.length === 0) return false;
  const source = exactMessageById(timelineMessages, lifecycle.inputMessageId);
  if (!source) return false;
  // Only a canonical cat source can receive the ordinary A2A failure report.
  // User/connector/system origins must keep this result as their visible row,
  // even though their source avatar also settles against the same result.
  if (source.from?.kind !== 'agent') return false;
  return lifecycle.requestedTargets.every(
    (targetId) =>
      source.lifecycle?.dispatchRefs?.filter(
        (ref) => ref.targetId === targetId && ref.phase === 'settled' && ref.statusMessageId === message.id,
      ).length === 1,
  );
}

interface MessageDispatchAvatarsProps {
  message: ChatMessage;
  timelineMessages: readonly ChatMessage[];
  activeRuns: readonly LifecycleActiveRun[];
  getCatLabel: (catId: string) => string;
}

export function MessageDispatchAvatars({
  message,
  timelineMessages,
  activeRuns,
  getCatLabel,
}: MessageDispatchAvatarsProps) {
  const projections = projectMessageDispatchAvatars(message, timelineMessages, activeRuns);
  if (projections.length === 0) return null;
  const alignsRight = message.type === 'user' && !message.catId;
  return (
    <ul
      className={`-mt-3 mb-4 flex gap-1.5 ${alignsRight ? 'justify-end pr-10' : 'justify-start pl-10'}`}
      data-testid="message-dispatch-avatars"
      aria-label="消息处理成员"
    >
      {projections.map((projection) => {
        const label = getCatLabel(projection.targetId);
        const processing = projection.phase === 'processing';
        return (
          <li
            key={`${projection.targetId}:${projection.statusMessageId}`}
            data-dispatch-target={projection.targetId}
            data-dispatch-phase={projection.phase}
            title={processing ? `${label} 正在处理` : `${label} 已处理`}
          >
            <CatAvatar catId={projection.targetId} size={22} status={processing ? 'streaming' : undefined} />
          </li>
        );
      })}
    </ul>
  );
}
