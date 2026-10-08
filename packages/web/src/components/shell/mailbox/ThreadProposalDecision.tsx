import type { ApprovalHubItem, ThreadProposal } from '@cat-cafe/shared';
import { suggestedReportingModeForWorkMode } from '@cat-cafe/shared';
import { useApprovalHost, useGuardedWrite } from '@/components/ApprovalHost';
import { useCatNameResolver } from '@/hooks/useCatNameResolver';
import { useApprovalHubStore } from '@/stores/approvalHubStore';
import { useShellCopy } from '../shell-copy';
import { mailboxEntryCopy } from './mailbox-entry.shell-copy';
import { threadProposalCopy } from './thread-proposal.shell-copy';
import { useThreadProposalRead } from './thread-proposal-read';

/** Complete F128 as-proposed decision; classic keeps its original override form and inline capability. */
export function ThreadProposalDecision({ item }: { item: ApprovalHubItem }) {
  const t = useShellCopy(threadProposalCopy);
  const entry = useShellCopy(mailboxEntryCopy);
  const { proposal, checking, reread } = useThreadProposalRead(item);
  const { writesLocked, originalPlaceAction, decisionWords } = useApprovalHost();
  const guardedWrite = useGuardedWrite();
  const deciding = useApprovalHubStore((s) => s.deciding[item.proposalId]);
  const approve = useApprovalHubStore((s) => s.approveProposal);
  const reject = useApprovalHubStore((s) => s.rejectProposal);
  const locked = writesLocked || Boolean(deciding) || proposal === null;
  const decide = (kind: 'approve' | 'reject') => {
    if (locked) return;
    void guardedWrite(kind, async () => {
      if (kind === 'approve') await approve(item.proposalId);
      else await reject(item.proposalId);
    });
  };
  return (
    <article data-testid={`approval-item-${item.proposalId}`} className="space-y-3 text-sm">
      {proposal ? (
        <ThreadProposalFacts proposal={proposal} />
      ) : (
        <output className="m-0 block">{checking ? t.checking : t.unavailable}</output>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-testid="approve-btn"
          disabled={locked}
          onClick={() => decide('approve')}
          className="shell-focusable rounded-lg px-3 py-1.5 font-medium disabled:opacity-50"
          style={{ background: 'var(--shell-primary)', color: 'var(--shell-primary-on)' }}
        >
          {deciding === 'approving' ? t.submitting : (decisionWords?.approve ?? '同意')}
        </button>
        <button
          type="button"
          data-testid="reject-btn"
          disabled={locked}
          onClick={() => decide('reject')}
          className="shell-nav-row shell-focusable rounded-lg px-3 py-1.5"
          style={{ border: '1px solid var(--shell-hairline)' }}
        >
          {decisionWords?.reject ?? '拒绝'}
        </button>
        <span className="ml-auto">{originalPlaceAction}</span>
        {!checking && !proposal ? (
          <button type="button" onClick={reread} className="shell-nav-row shell-focusable rounded-lg px-2 py-1.5">
            {entry.reread}
          </button>
        ) : null}
      </div>
    </article>
  );
}

function ThreadProposalFacts({ proposal }: { proposal: ThreadProposal }) {
  const t = useShellCopy(threadProposalCopy);
  const resolveCatName = useCatNameResolver();
  return (
    <>
      <p className="m-0">
        <span style={{ color: 'var(--shell-muted)' }}>{t.proposer}</span>
        {resolveCatName(proposal.sourceCatId)}
      </p>
      <div>
        <p className="m-0 font-medium">{t.why}</p>
        <p className="m-0 whitespace-pre-wrap break-words" data-testid="mailbox-proposal-reason">
          {proposal.reason}
        </p>
      </div>
      <p className="m-0">
        {t.executor}
        {proposal.preferredCats.length ? proposal.preferredCats.map(resolveCatName).join('、') : t.unspecified}
      </p>
      <p className="m-0">
        {t.approved(proposal.title)}
        {proposal.initialMessage ? t.initial : t.noInitial}
      </p>
      {proposal.initialMessage ? (
        <p className="m-0 whitespace-pre-wrap break-words">{proposal.initialMessage}</p>
      ) : null}
      <dl className="m-0 space-y-1 text-xs" style={{ color: 'var(--shell-muted)' }}>
        <div>
          <dt className="inline">{t.parent}</dt>
          <dd className="m-0 inline break-all">{proposal.parentThreadId}</dd>
        </div>
        <div>
          <dt className="inline">{t.project}</dt>
          <dd className="m-0 inline break-all">
            {proposal.projectPath === 'default' ? t.unclassified : proposal.projectPath}
          </dd>
        </div>
        <div>
          <dt className="inline">{t.collaboration}</dt>
          <dd className="m-0 inline">
            {proposal.declaredWorkMode ? t.workMode[proposal.declaredWorkMode] : t.unknown}
          </dd>
        </div>
        <div>
          <dt className="inline">{t.reporting}</dt>
          <dd className="m-0 inline">
            {t.reportingMode[proposal.reportingMode ?? suggestedReportingModeForWorkMode(proposal.declaredWorkMode)]}
          </dd>
        </div>
        {proposal.subjectTaskId ? (
          <div>
            {t.task}
            {proposal.subjectTaskTitle
              ? `${proposal.subjectTaskTitle} (${proposal.subjectTaskId})`
              : proposal.subjectTaskId}
          </div>
        ) : null}
        {proposal.approvedDevelopmentScope ? (
          <div className="space-y-1 break-all" data-testid="mailbox-development-scope">
            <div>
              {t.phase}
              {proposal.approvedDevelopmentScope.featureRef} · {proposal.approvedDevelopmentScope.phaseKey}
            </div>
            <div>
              {t.scope}
              {proposal.approvedDevelopmentScope.workUnitRef}
            </div>
            <div>
              {t.source}
              {proposal.approvedDevelopmentScope.acceptedSourceRef}
            </div>
            <div>
              {t.revision}
              {proposal.approvedDevelopmentScope.acceptedRevision}
            </div>
          </div>
        ) : null}
      </dl>
    </>
  );
}
