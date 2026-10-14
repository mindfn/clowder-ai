import type { UnifiedAttentionItemV1 } from '@cat-cafe/shared';
import { useId, useSyncExternalStore } from 'react';
import { ShellCatAvatar } from '../ShellCatAvatar';
import { useShellCopy } from '../shell-copy';
import { isHostableApproval } from './approval-match';
import { describeReconcile } from './approval-reconcile';
import { type ApprovalSessions, sessionKey } from './approval-sessions';
import { HostedApprovalCard } from './HostedApprovalCard';
import { MailboxChoiceCard } from './MailboxChoiceCard';
import { MailboxItemPersonalAction } from './MailboxItemPersonalAction';
import { MailboxWorkDetails } from './MailboxWorkDetails';
import { mailboxEntryCopy } from './mailbox-entry.shell-copy';
import { useMailboxRowText } from './mailbox-row-text';
import { type OriginalPlace, resolveOriginalPlace } from './original-place';
import { PlaceAction } from './PlaceAction';
import type { ApprovalAddress } from './read-evidence';
import { UserMentionDetails } from './UserMentionDetails';
import type { MailboxPersonalActions } from './use-mailbox-personal-preferences';

export const KIND_LABEL: Record<UnifiedAttentionItemV1['kind'], string> = mailboxEntryCopy.zh.kinds;

function Chevron({ open }: { open: boolean }) {
  return (
    <span
      aria-hidden="true"
      className="inline-block"
      style={{
        color: 'var(--shell-muted)',
        transform: open ? 'rotate(90deg)' : undefined,
        transition: 'transform 120ms',
      }}
    >
      ›
    </span>
  );
}

type Hosted = { sessions: ApprovalSessions; ownerUserId: string };

function SessionLineText({ hosted, approval }: { hosted: Hosted; approval: ApprovalAddress }) {
  const t = useShellCopy(mailboxEntryCopy);
  const { sessions, ownerUserId } = hosted;
  useSyncExternalStore(sessions.subscribe, sessions.getVersion, sessions.getVersion);
  const key = sessionKey(ownerUserId, approval);
  const session = sessions.get(key);
  const view = session ? describeReconcile(session.model.state) : null;
  if (!view?.line) return null;
  return (
    <div className="flex items-center gap-2 px-4 pb-3">
      <output
        className="m-0 block flex-1 text-xs font-medium"
        style={{ color: 'var(--shell-body)' }}
        data-testid="mailbox-row-session-line"
      >
        {view.line}
      </output>
      {view.canReread ? (
        <button
          type="button"
          data-testid="mailbox-row-reread"
          onClick={() => sessions.reread(key)}
          className="shell-nav-row shell-focusable flex-none rounded-lg px-2 py-1 text-xs"
        >
          {t.reread}
        </button>
      ) : null}
    </div>
  );
}

/**
 * Where a row's decision stands, when the row is closed or from the previous read. An in-flight write, an unknown or a result
 * is never shown as nothing; a row nobody has acted on says nothing here. An open row's card says it itself.
 */
function RowSessionLine({
  open,
  hosted,
  approval,
}: {
  open: boolean;
  hosted: Hosted | undefined;
  approval: ApprovalAddress | undefined;
}) {
  if (open || !hosted || !approval) return null;
  return <SessionLineText hosted={hosted} approval={approval} />;
}

/** The opened row: what the read carries about it, and either the original card (a decidable approval) or the one way to the place. */
function RowBody({
  item,
  id,
  heading,
  hosted,
  personal,
  readCurrent,
  onOpen,
}: {
  item: UnifiedAttentionItemV1;
  id: string;
  heading: string;
  hosted: Hosted | undefined;
  personal?: MailboxPersonalActions;
  readCurrent: boolean;
  onOpen: (place: OriginalPlace) => void;
}) {
  const t = useShellCopy(mailboxEntryCopy);
  const place = resolveOriginalPlace(item);
  const hostable = hosted !== undefined && item.approval !== undefined && isHostableApproval(item.approval);
  return (
    <section
      id={id}
      aria-label={`${item.choiceRequest ? t.choice : t.kinds[item.kind]}：${heading}`}
      data-testid="mailbox-item-body"
      className="flex flex-col gap-3 px-3 pb-3 pt-1"
      style={{ color: 'var(--shell-ink)' }}
    >
      {item.userMention ? (
        <UserMentionDetails key={item.userMention.messageId} request={item.userMention} showHandling={!personal} />
      ) : item.approval || item.choiceRequest ? null : (
        <MailboxWorkDetails item={item} />
      )}
      {personal && !hostable && !item.userMention ? (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <MailboxItemPersonalAction item={item} personal={personal} />
        </div>
      ) : null}
      {item.choiceRequest && hosted ? (
        <MailboxChoiceCard
          key={`${item.choiceRequest.interactionId}:${item.choiceRequest.revision}`}
          choice={item.choiceRequest}
          ownerUserId={hosted.ownerUserId}
          readCurrent={readCurrent}
        />
      ) : null}
      {hostable && hosted ? (
        <HostedApprovalCard
          item={item}
          ownerUserId={hosted.ownerUserId}
          sessions={hosted.sessions}
          secondaryAction={personal ? <MailboxItemPersonalAction item={item} personal={personal} /> : undefined}
          place={place}
          onOpen={onOpen}
          readCurrent={readCurrent}
        />
      ) : item.userMention && personal ? null : (
        <PlaceAction quiet={Boolean(item.approval)} place={place} onOpen={onOpen} />
      )}
    </section>
  );
}

/**
 * One 待办 item. Collapsed it is a line; expanded (one at a time) it says what the read carries and offers exactly one
 * way forward: open the place that owns the decision. A row from a previous read is never interactive.
 */
export function MailboxRow({
  item,
  rowKey,
  stale,
  expanded,
  onToggle,
  onOpen,
  hosted,
  personal,
  readCurrent = !stale,
}: {
  item: UnifiedAttentionItemV1;
  rowKey: string;
  stale: boolean;
  expanded: boolean;
  onToggle: () => void;
  onOpen: (place: OriginalPlace) => void;
  /** Where decisions made on a row's original card are followed, and whose they are. Absent: the row only points to the place. */
  hosted?: Hosted;
  personal?: MailboxPersonalActions;
  readCurrent?: boolean;
}) {
  const t = useShellCopy(mailboxEntryCopy);
  const bodyId = useId();
  const { catId, lead, title, source, time } = useMailboxRowText(item);
  const heading = lead ? `${lead} ${title}` : title;
  const session =
    hosted && item.approval ? hosted.sessions.get(sessionKey(hosted.ownerUserId, item.approval)) : undefined;
  const retainingDecision = session !== undefined && session.model.state.kind !== 'idle';
  const open = expanded && (!stale || retainingDecision);
  return (
    <li
      data-testid="mailbox-item"
      data-kind-label={item.choiceRequest ? t.choice : t.kinds[item.kind]}
      data-row-key={rowKey}
      data-stale={stale ? 'true' : undefined}
      data-expanded={open ? 'true' : 'false'}
      className="rounded-[14px]"
      style={{
        opacity: stale ? 0.6 : undefined,
        border: `1px solid ${open ? 'var(--shell-hairline-strong)' : 'var(--shell-hairline)'}`,
        background: item.userMention ? 'var(--shell-work)' : 'var(--shell-paper)',
      }}
    >
      <div className={item.userMention && personal ? 'flex items-start gap-2 px-3 py-3' : undefined}>
        <button
          type="button"
          data-testid="mailbox-item-toggle"
          aria-expanded={open}
          aria-controls={bodyId}
          disabled={stale}
          onClick={onToggle}
          className={`shell-nav-row shell-focusable flex min-w-0 flex-1 flex-col gap-1.5 rounded-[14px] text-left text-sm ${item.userMention && personal ? '' : 'w-full px-4 py-3'}`}
        >
          {item.userMention ? (
            <>
              <span className="flex w-full items-start gap-2">
                {catId ? (
                  <span className="mt-px flex-none" data-testid="mailbox-item-avatar">
                    <ShellCatAvatar catId={catId} size={24} />
                  </span>
                ) : null}
                <span
                  data-testid="mailbox-mention-preview"
                  className="line-clamp-2 min-w-0 break-words text-sm"
                  style={{ color: 'var(--shell-body)' }}
                >
                  {source}：{item.userMention.content}
                </span>
              </span>
              <span
                className="flex w-full min-w-0 items-center gap-2 pl-8 text-xs"
                style={{ color: 'var(--shell-muted)' }}
              >
                <span className={`min-w-0 flex-1 ${open ? 'break-words' : 'truncate'}`}>{title}</span>
                {time && !personal ? <time className="flex-none whitespace-nowrap">{time}</time> : null}
                <Chevron open={open} />
              </span>
            </>
          ) : (
            <>
              <span className="flex w-full items-center gap-2">
                <span
                  className="flex-none rounded px-1.5 text-micro"
                  style={{ background: 'var(--shell-selected)', color: 'var(--shell-muted)' }}
                >
                  {item.choiceRequest ? t.choice : t.kinds[item.kind]}
                </span>
                <span className="flex-1" />
                {time ? (
                  <span className="text-xs" style={{ color: 'var(--shell-muted)' }}>
                    {time}
                  </span>
                ) : null}
                <Chevron open={open} />
              </span>
              <span className="flex w-full items-start gap-2">
                {catId ? (
                  <span className="mt-px flex-none" data-testid="mailbox-item-avatar">
                    <ShellCatAvatar catId={catId} size={24} />
                  </span>
                ) : null}
                <span className={`${open ? 'block' : 'line-clamp-2 block'} min-w-0 flex-1`}>
                  {lead ? <span className="font-semibold">{lead} </span> : null}
                  {title}
                </span>
              </span>
              {source ? (
                <span className="block truncate text-xs" style={{ color: 'var(--shell-muted)' }}>
                  {source}
                </span>
              ) : null}
            </>
          )}
        </button>
        {item.userMention && personal ? (
          <div className="flex flex-none flex-col items-end gap-1.5" data-testid="mailbox-row-actions">
            <div className="flex items-center gap-1">
              <MailboxItemPersonalAction item={item} personal={personal} />
              <PlaceAction quiet compact place={resolveOriginalPlace(item)} onOpen={onOpen} />
            </div>
            {time ? (
              <time className="whitespace-nowrap text-xs" style={{ color: 'var(--shell-muted)' }}>
                {time}
              </time>
            ) : null}
          </div>
        ) : null}
      </div>
      <RowSessionLine open={open} hosted={hosted} approval={item.approval} />
      {open ? (
        <RowBody
          item={item}
          id={bodyId}
          heading={heading}
          hosted={hosted}
          personal={personal}
          readCurrent={readCurrent}
          onOpen={onOpen}
        />
      ) : null}
    </li>
  );
}
