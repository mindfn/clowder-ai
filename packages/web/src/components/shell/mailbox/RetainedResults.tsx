import { ApprovalResultLink } from './ApprovalResultLink';
import { useApprovalHeading } from './approval-heading';
import { describeReconcile } from './approval-reconcile';
import { type ApprovalSession, type ApprovalSessions } from './approval-sessions';

const MUTED = { color: 'var(--shell-muted)' } as const;

/** A decision still being written or confirmed is not the user's to dismiss; every other state is theirs to read and clear. */
const IN_FLIGHT = new Set(['writing', 'confirming']);

export function RetainedResult({ session, sessions }: { session: ApprovalSession; sessions: ApprovalSessions }) {
  const { lead, title } = useApprovalHeading(session.approval);
  const view = describeReconcile(session.model.state);
  return (
    <li
      data-testid="mailbox-retained-result"
      data-state={session.model.state.kind}
      className="flex flex-col gap-1.5 rounded-[14px] px-4 py-3 text-sm"
      style={{ border: '1px solid var(--shell-hairline)', background: 'var(--shell-paper)' }}
    >
      <span className="block">
        <span className="font-semibold">{lead} </span>
        {title}
      </span>
      {view.line ? (
        <output className="m-0 block font-medium" data-testid="mailbox-retained-line">
          {view.line}
        </output>
      ) : null}
      <div className="flex items-center gap-2">
        <ApprovalResultLink state={session.model.state} />
        {view.canReread ? (
          <button
            type="button"
            data-testid="mailbox-retained-reread"
            onClick={() => sessions.reread(session.key)}
            className="shell-nav-row shell-focusable rounded-lg px-2 py-1 text-xs"
          >
            重新读取
          </button>
        ) : null}
        {IN_FLIGHT.has(session.model.state.kind) ? null : (
          <button
            type="button"
            data-testid="mailbox-retained-dismiss"
            onClick={() => sessions.close(session.key)}
            className="shell-nav-row shell-focusable rounded-lg px-2 py-1 text-xs"
            style={MUTED}
          >
            知道了
          </button>
        )}
      </div>
    </li>
  );
}
