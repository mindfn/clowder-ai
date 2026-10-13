import { actorDisplayName, formatEventTime } from './channel-model.js';
import type { CollectiveEventEnvelope, CollectiveParticipant } from './client-types.js';
import { MemberAvatar } from './MemberAvatar.js';
import { MessageMarkdown } from './MessageMarkdown.js';
import { authorPresentation } from './message-presentation.js';
import { useRoomPresentation } from './use-room-presentation.js';

export function MessageAvatar({
  event,
  participants = [],
  compact = false,
}: {
  readonly event: CollectiveEventEnvelope;
  readonly participants?: readonly CollectiveParticipant[];
  readonly compact?: boolean;
}) {
  const actor = event.actor;
  const card =
    actor.kind === 'agent'
      ? participants.find(
          (participant) =>
            participant.serviceInstanceId === event.serviceInstanceId &&
            participant.connectionId === actor.provenance.connectionId &&
            participant.catId === actor.provenance.catId,
        )
      : undefined;
  return (
    <MemberAvatar
      name={actorDisplayName(event)}
      kind={event.actor.kind}
      avatarUrl={event.actor.kind === 'human' ? event.actor.avatarUrl : card?.avatarDataUrl}
      compact={compact}
    />
  );
}

export function MessageBody({
  event,
  participants = [],
  responseState,
}: {
  readonly event: CollectiveEventEnvelope;
  readonly participants?: readonly CollectiveParticipant[];
  readonly responseState?: 'waiting' | 'responded';
}) {
  const recipient = event.recipient?.kind === 'agent' ? event.recipient : undefined;
  const namedCat = recipient
    ? participants.find(
        (participant) =>
          participant.serviceInstanceId === event.serviceInstanceId &&
          participant.connectionId === recipient.connectionId &&
          participant.humanId === recipient.humanId &&
          participant.catId === recipient.agentId,
      )
    : undefined;
  return (
    <>
      <MessageMarkdown
        source={event.body}
        prefix={
          recipient ? (
            <span className="message-inline-mention">@{namedCat?.displayName ?? recipient.agentId}</span>
          ) : undefined
        }
      />
      {event.attentionRequest && (
        <p className="request-kind">
          希望伙伴回应
          {responseState === 'waiting' ? ' · 尚未有人回应' : responseState === 'responded' ? ' · 已有回应' : ''}
        </p>
      )}
      {event.workRequest && <p className="request-kind">请求持续处理</p>}
    </>
  );
}

export function TopicMessage({
  event,
  participants = [],
  onOpenMember,
  currentHumanId,
  presentation,
  showTime = true,
}: {
  readonly event: CollectiveEventEnvelope;
  readonly participants?: readonly CollectiveParticipant[];
  readonly onOpenMember?: (event: CollectiveEventEnvelope) => void;
  /** The viewer (`snapshot.me.human.humanId`). Without it nothing is "yours": a person is on the left, named. */
  readonly currentHumanId?: string;
  /** Overrides the frame default (tests, previews). */
  readonly presentation?: 'v2' | 'classic';
  /** Time visibility supplied by the surrounding flow; consecutive own messages show it once. */
  readonly showTime?: boolean;
}) {
  const v2 = useRoomPresentation(presentation) === 'v2';
  const author = authorPresentation(event, currentHumanId);
  return (
    <article className="topic-message" data-author={v2 ? author : undefined}>
      {onOpenMember ? (
        <button
          type="button"
          className="avatar-button"
          onClick={() => onOpenMember(event)}
          aria-label={`查看 ${actorDisplayName(event)}`}
        >
          <MessageAvatar event={event} participants={participants} compact />
        </button>
      ) : (
        <MessageAvatar event={event} participants={participants} compact />
      )}
      <div>
        <header className="message-meta">
          <strong>{actorDisplayName(event)}</strong>
          {(!v2 || showTime) && (
            <time className={v2 ? 'message-time' : undefined} dateTime={event.acceptedAt}>
              {formatEventTime(event.acceptedAt)}
            </time>
          )}
        </header>
        <MessageBody event={event} participants={participants} />
      </div>
    </article>
  );
}
