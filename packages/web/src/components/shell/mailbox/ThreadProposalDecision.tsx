import type { ApprovalHubItem, ThreadProposal } from '@cat-cafe/shared';
import { suggestedReportingModeForWorkMode } from '@cat-cafe/shared';
import { useApprovalHost, useGuardedWrite } from '@/components/ApprovalHost';
import { formatDeclaredWorkMode, formatReportingMode } from '@/components/rich/ProposalCardFields';
import { useCatNameResolver } from '@/hooks/useCatNameResolver';
import { useApprovalHubStore } from '@/stores/approvalHubStore';
import { useThreadProposalRead } from './thread-proposal-read';

/** Complete F128 as-proposed decision; classic keeps its original override form and inline capability. */
export function ThreadProposalDecision({ item }: { item: ApprovalHubItem }) {
  const { proposal, checking, reread } = useThreadProposalRead(item);
  const { writesLocked, originalPlaceAction } = useApprovalHost();
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
        <output className="m-0 block">{checking ? '正在核对原提议…' : '无法核实这条提议，重新读取后再试。'}</output>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <span className="mr-auto">{originalPlaceAction}</span>
        <button
          type="button"
          data-testid="approve-btn"
          disabled={locked}
          onClick={() => decide('approve')}
          className="shell-focusable rounded-lg px-3 py-1.5 font-medium disabled:opacity-50"
          style={{ background: 'var(--shell-primary)', color: 'var(--shell-primary-on)' }}
        >
          {deciding === 'approving' ? '正在提交…' : '同意'}
        </button>
        <button
          type="button"
          data-testid="reject-btn"
          disabled={locked}
          onClick={() => decide('reject')}
          className="shell-nav-row shell-focusable rounded-lg px-3 py-1.5"
          style={{ border: '1px solid var(--shell-hairline)' }}
        >
          拒绝
        </button>
        {!checking && !proposal ? (
          <button type="button" onClick={reread} className="shell-nav-row shell-focusable rounded-lg px-2 py-1.5">
            重新读取
          </button>
        ) : null}
      </div>
    </article>
  );
}

function ThreadProposalFacts({ proposal }: { proposal: ThreadProposal }) {
  const resolveCatName = useCatNameResolver();
  return (
    <>
      <p className="m-0">
        <span style={{ color: 'var(--shell-muted)' }}>提议者：</span>
        {resolveCatName(proposal.sourceCatId)}
      </p>
      <div>
        <p className="m-0 font-medium">为什么</p>
        <p className="m-0 whitespace-pre-wrap break-words" data-testid="mailbox-proposal-reason">
          {proposal.reason}
        </p>
      </div>
      <p className="m-0">
        执行者：
        {proposal.preferredCats.length ? proposal.preferredCats.map(resolveCatName).join('、') : '原提议未指定'}
      </p>
      <p className="m-0">
        同意后：创建「{proposal.title}」对话
        {proposal.initialMessage
          ? '，在对话中发送下面这条任务；是否开工以执行回执为准。'
          : '；原提议没有附带启动任务。'}
      </p>
      {proposal.initialMessage ? (
        <p className="m-0 whitespace-pre-wrap break-words">{proposal.initialMessage}</p>
      ) : null}
      <dl className="m-0 space-y-1 text-xs" style={{ color: 'var(--shell-muted)' }}>
        <div>
          <dt className="inline">父对话：</dt>
          <dd className="m-0 inline break-all">{proposal.parentThreadId}</dd>
        </div>
        <div>
          <dt className="inline">项目：</dt>
          <dd className="m-0 inline break-all">
            {proposal.projectPath === 'default' ? '未分类；同意即保留未分类' : proposal.projectPath}
          </dd>
        </div>
        <div>
          <dt className="inline">协作：</dt>
          <dd className="m-0 inline">
            {proposal.declaredWorkMode ? formatDeclaredWorkMode(proposal.declaredWorkMode) : '尚未声明'}
          </dd>
        </div>
        <div>
          <dt className="inline">回报：</dt>
          <dd className="m-0 inline">
            {formatReportingMode(
              proposal.reportingMode ?? suggestedReportingModeForWorkMode(proposal.declaredWorkMode),
            )}
          </dd>
        </div>
        {proposal.subjectTaskId ? (
          <div>
            关联任务：
            {proposal.subjectTaskTitle
              ? `${proposal.subjectTaskTitle} (${proposal.subjectTaskId})`
              : proposal.subjectTaskId}
          </div>
        ) : null}
        {proposal.approvedDevelopmentScope ? (
          <div className="space-y-1 break-all" data-testid="mailbox-development-scope">
            <div>
              功能与阶段：{proposal.approvedDevelopmentScope.featureRef} · {proposal.approvedDevelopmentScope.phaseKey}
            </div>
            <div>执行范围：{proposal.approvedDevelopmentScope.workUnitRef}</div>
            <div>授权来源：{proposal.approvedDevelopmentScope.acceptedSourceRef}</div>
            <div>来源版本：{proposal.approvedDevelopmentScope.acceptedRevision}</div>
          </div>
        ) : null}
      </dl>
    </>
  );
}
