'use client';
import type { ApprovalHubItem } from '@cat-cafe/shared';
import { useCallback, useState } from 'react';
import { type ApprovalWriteKind, useApprovalHost } from '@/components/ApprovalHost';
import { ApprovalProvenanceLinks } from '@/components/ApprovalProvenanceLinks';
import { MarkdownContent } from '@/components/MarkdownContent';
import { useShellCopy } from '@/components/shell/shell-copy';
import { useShellLanguage } from '@/components/shell/shell-language';
import { useApprovalItemActions } from '@/components/useApprovalItemActions';
import { useApprovalHubStore } from '@/stores/approvalHubStore';
import { ApprovalMember } from './ApprovalMember';
import { evalRepairCopy } from './eval-repair.shell-copy';
import { evalRepairModel } from './eval-repair-model';
import { readEvalRepairPending } from './read-eval-repair';

/** The original repair body and original Hub writer, shared by Chat and the Inbox host. */
export function EvalRepairApprovalCard({
  item,
  beforeWrite,
  afterWrite,
}: {
  item: ApprovalHubItem;
  beforeWrite?: (kind: ApprovalWriteKind) => Promise<boolean>;
  afterWrite?: () => Promise<void>;
}) {
  const t = useShellCopy(evalRepairCopy),
    language = useShellLanguage();
  const host = useApprovalHost();
  const model = evalRepairModel(item);
  const [refused, setRefused] = useState(false);
  const prepare = useCallback(
    async (kind: ApprovalWriteKind) => {
      if (beforeWrite) {
        const ready = await beforeWrite(kind);
        setRefused(!ready);
        return ready;
      }
      if (item.navigation.state !== 'anchored') return false;
      const ready = Boolean(await readEvalRepairPending(item.proposalId, item.navigation.approvalCardRef, item));
      setRefused(!ready);
      return ready;
    },
    [beforeWrite, item],
  );
  const actions = useApprovalItemActions(item, prepare, afterWrite);
  const close = useApprovalHubStore((s) => s.close);
  const canDecide = Boolean(
    model && item.resolution === 'open' && item.inlineApprovable && item.decisionMode === 'approve-reject',
  );
  const busy = actions.checking || Boolean(actions.decidingState);
  return (
    <article
      data-testid={`approval-item-${item.proposalId}`}
      className="space-y-3 rounded-xl border-l-4 p-3 text-sm"
      style={{ color: 'var(--shell-ink)', background: 'var(--shell-paper)', borderColor: 'var(--semantic-warning)' }}
    >
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-[var(--shell-muted)]">
        <span>{t.kind}</span>
        <ApprovalMember catId={item.requesterCatId} />
        <time className="ml-auto whitespace-nowrap">
          {new Date(item.createdAt).toLocaleString(language === 'en' ? 'en-US' : 'zh-CN')}
        </time>
      </header>
      {model ? (
        <>
          <h3 className="font-semibold">{item.summary.replace(/^Eval repair\s*·\s*/u, '')}</h3>
          <section>
            <h4 className="mb-1 font-medium">{t.change}</h4>
            <MarkdownContent content={model.expectedChange} />
          </section>
          <section>
            <h4 className="mb-1 font-medium">{t.cost}</h4>
            <p className="whitespace-pre-wrap break-words">{model.costAndRollback}</p>
          </section>
          <section>
            <h4 className="mb-1 font-medium">{t.withdraw}</h4>
            <p className="whitespace-pre-wrap break-words">{model.withdrawalCondition}</p>
          </section>
          <section>
            <h4 className="mb-1 font-medium">{t.target}</h4>
            <p className="break-words">{model.target.assetId}</p>
            <details>
              <summary className="shell-focusable cursor-pointer">{t.version}</summary>
              <p className="break-all">{model.target.version}</p>
            </details>
          </section>
        </>
      ) : (
        <p>{t.unverified}</p>
      )}
      {item.resolution !== 'open' ? (
        <output data-testid="approval-lifecycle-badge">
          {item.resolution === 'accepted' ? t.accepted : item.resolution === 'rejected' ? t.rejected : t.closed}
        </output>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {canDecide && !actions.isStale ? (
          <button
            type="button"
            data-testid="approve-btn"
            disabled={busy || host.writesLocked}
            onClick={actions.handleApprove}
            className="shell-focusable rounded-md px-3 py-1.5 disabled:opacity-50"
            style={{ background: 'var(--shell-primary)', color: 'var(--shell-primary-on)' }}
          >
            {busy ? t.submitting : t.approve}
          </button>
        ) : null}
        {canDecide ? (
          <button
            type="button"
            data-testid="reject-btn"
            disabled={busy || host.writesLocked}
            onClick={actions.handleReject}
            className="shell-focusable rounded-md border border-[var(--shell-hairline)] px-3 py-1.5 disabled:opacity-50"
          >
            {t.reject}
          </button>
        ) : null}
        {host.presentation === 'mailbox' ? (
          host.originalPlaceAction
        ) : (
          <ApprovalProvenanceLinks navigation={item.navigation} onBeforeNavigate={close} />
        )}
      </div>
      {refused ? <p className="text-xs text-[var(--shell-muted)]">{t.unverified}</p> : null}
      {actions.feedbackDialog}
    </article>
  );
}
