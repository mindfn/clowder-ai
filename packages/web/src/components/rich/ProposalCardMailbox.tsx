import type { ThreadProposal } from '@cat-cafe/shared';
import type { ApprovalHost } from '@/components/ApprovalHost';
import { MarkdownContent } from '@/components/MarkdownContent';
import { useShellCopy } from '@/components/shell/shell-copy';
import { pushThreadRouteWithHistory } from '@/components/ThreadSidebar/thread-navigation';
import { useThreadDisplayInfo } from '@/hooks/useThreadDisplayInfo';
import { ApprovalMember } from './ApprovalMember';
import { ProposalCardEditor } from './ProposalCardEditor';
import { proposalCardCopy } from './proposal-card.shell-copy';
import type { ProposalCardState } from './useProposalCardState';

const secondary =
  'shell-nav-row shell-focusable rounded-lg border border-[var(--shell-hairline)] px-2 py-1.5 text-xs disabled:opacity-50';

/** A compact placement of the original card; no separate approval or override writer. */
export function ProposalCardMailbox({
  proposal,
  state,
  host,
}: {
  proposal: ThreadProposal;
  state: ProposalCardState;
  host: ApprovalHost;
}) {
  const t = useShellCopy(proposalCardCopy);
  const { currentThread } = useThreadDisplayInfo(proposal.parentThreadId);
  const project =
    proposal.projectPath === 'default' ? t.unclassified : proposal.projectPath.split('/').filter(Boolean).at(-1);
  return (
    <article data-testid={`approval-item-${proposal.proposalId}`} className="min-w-0 space-y-3 text-sm">
      {state.editing ? (
        <ProposalCardEditor state={state} />
      ) : (
        <>
          <details className="group text-sm" data-testid="proposal-reason">
            <summary className="shell-focusable cursor-pointer" style={{ color: 'var(--shell-body)' }}>
              <span className="hidden group-open:inline">{t.why}</span>
              <div className="line-clamp-3 break-words group-open:hidden">
                <MarkdownContent content={proposal.reason} className="!text-sm [&_p]:mb-0" disableCommandPrefix />
              </div>
            </summary>
            <div
              role="region"
              aria-label={t.why}
              // biome-ignore lint/a11y/noNoninteractiveTabindex: the expanded reason region supports keyboard scrolling
              tabIndex={0}
              className="mt-2 max-h-48 overflow-y-auto break-words"
            >
              <MarkdownContent content={proposal.reason} className="!text-sm" disableCommandPrefix />
            </div>
          </details>
          <dl className="m-0 space-y-1 text-xs">
            <div>
              <dt className="inline text-[var(--shell-muted)]">{t.executor}: </dt>
              <dd className="inline-flex flex-wrap items-center gap-2">
                {proposal.preferredCats.length
                  ? proposal.preferredCats.map((catId) => <ApprovalMember key={catId} catId={catId} />)
                  : t.unspecified}
              </dd>
            </div>
            <div>
              <dt className="inline text-[var(--shell-muted)]">{t.parent}: </dt>
              <dd className="inline break-words">{currentThread?.title || t.parentUnavailable}</dd>
            </div>
            <div>
              <dt className="inline text-[var(--shell-muted)]">{t.project}: </dt>
              <dd className="inline break-words" title={proposal.projectPath}>
                {project}
              </dd>
            </div>
            <div>
              <dt className="inline text-[var(--shell-muted)]">{t.follow}: </dt>
              <dd className="inline">
                {state.effectiveDeclaredWorkMode ? t.workMode[state.effectiveDeclaredWorkMode] : t.unknown} ·{' '}
                {t.reportingMode[state.effectiveReportingMode]}
              </dd>
            </div>
          </dl>
          {proposal.initialMessage ? (
            <details
              data-testid="proposal-initial-message"
              className="rounded-lg border border-[var(--shell-hairline)] p-2"
            >
              <summary className="shell-focusable cursor-pointer text-xs font-medium">{t.initial}</summary>
              <div
                role="region"
                className="mt-2 max-h-64 overflow-y-auto break-words"
                // biome-ignore lint/a11y/noNoninteractiveTabindex: the bounded text region must support keyboard scrolling
                tabIndex={0}
                aria-label={t.initial}
              >
                <MarkdownContent content={proposal.initialMessage} className="!text-sm" disableCommandPrefix />
              </div>
            </details>
          ) : null}
          {proposal.approvedDevelopmentScope || proposal.subjectTaskId ? (
            <details className="text-xs">
              <summary className="shell-focusable cursor-pointer text-[var(--shell-muted)]">{t.technical}</summary>
              {proposal.subjectTaskTitle ? <p>{proposal.subjectTaskTitle}</p> : null}
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all">
                {JSON.stringify(
                  { subjectTaskId: proposal.subjectTaskId, scope: proposal.approvedDevelopmentScope },
                  null,
                  2,
                )}
              </pre>
            </details>
          ) : null}
        </>
      )}
      {state.status === 'pending' ? (
        <>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={state.pinOnApprove}
              onChange={(e) => state.setPinOnApprove(e.target.checked)}
              disabled={state.loading}
            />
            {t.pin}
          </label>
          <div className="flex flex-wrap items-center gap-2" data-testid="proposal-actions">
            <button
              type="button"
              data-testid="approve-btn"
              disabled={state.writeBlocked}
              onClick={state.approve}
              className="shell-focusable rounded-lg px-3 py-1.5 text-xs font-medium disabled:opacity-50"
              style={{ background: 'var(--shell-primary)', color: 'var(--shell-primary-on)' }}
            >
              {state.loading ? t.submitting : state.editing ? t.approveEdited : t.approve}
            </button>
            <button
              type="button"
              data-testid="reject-btn"
              disabled={state.writeBlocked}
              onClick={state.reject}
              className={secondary}
            >
              {host.decisionWords?.reject ?? t.reject}
            </button>
            <button
              type="button"
              disabled={state.loading}
              onClick={() => state.setEditing((v) => !v)}
              className={secondary}
            >
              {state.editing ? t.cancel : t.edit}
            </button>
            {host.originalPlaceAction}
          </div>
        </>
      ) : (
        <output className="flex flex-wrap items-center gap-2">
          <span>
            {state.status === 'approved'
              ? t.approved
              : state.status === 'rejected'
                ? t.rejected
                : state.status === 'withdrawn'
                  ? t.withdrawn
                  : t.submitting}
          </span>
          {state.status === 'approved' && state.resultThreadId ? (
            <button
              type="button"
              disabled={host.writesLocked}
              className={secondary}
              onClick={() => {
                if (state.resultThreadId && host.authorizeWrite('producer-card', { continuation: true }))
                  pushThreadRouteWithHistory(state.resultThreadId, typeof window !== 'undefined' ? window : undefined);
              }}
            >
              {t.open}
            </button>
          ) : null}
          {host.originalPlaceAction}
        </output>
      )}
      {state.error ? <output className="block text-xs text-[var(--semantic-critical)]">{state.error}</output> : null}
    </article>
  );
}
