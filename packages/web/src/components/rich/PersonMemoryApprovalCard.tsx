'use client';
import { type ApprovalHubItem, isPersonMemoryProposalCardBlock, type RichCardBlock } from '@cat-cafe/shared';
import { useRef } from 'react';
import { useApprovalHost } from '../ApprovalHost';
import { PersonMemoryClaimSelector } from '../PersonMemoryClaimSelector';
import { useShellCopy } from '../shell/shell-copy';
import { useApprovalItemActions } from '../useApprovalItemActions';
import { ApprovalMember } from './ApprovalMember';
import { CardBlock } from './CardBlock';
import { PersonMemoryUndo } from './PersonMemoryUndo';
import { personMemoryCopy } from './person-memory.shell-copy';
import type { PersonMemoryCoordinate } from './person-memory-proposal-source';
import { usePersonMemoryProposal } from './use-person-memory-proposal';

/** The same original selector, original writer and exact owner receipt in Chat and every approval host. */
export function PersonMemoryApprovalCard({
  item,
  proposalId = item?.proposalId ?? '',
  coordinate,
  block,
}: {
  item?: ApprovalHubItem;
  proposalId?: string;
  coordinate?: PersonMemoryCoordinate;
  block?: RichCardBlock;
}) {
  const t = useShellCopy(personMemoryCopy),
    host = useApprovalHost();
  const ref = coordinate ?? (item?.navigation.state === 'anchored' ? item.navigation.approvalCardRef : undefined);
  const read = usePersonMemoryProposal(proposalId, ref, block);
  const last = useRef<{ proposalId: string; item: ApprovalHubItem } | null>(null);
  if (read.source?.item) last.current = { proposalId, item: read.source.item };
  const settled = read.source && !read.source.item;
  const shown = read.source?.item ?? (!settled && last.current?.proposalId === proposalId ? last.current.item : null);
  const snapshot = read.source?.snapshot,
    receipt = snapshot?.decisionReceipt;
  const label = snapshot
    ? snapshot.status === 'materialized'
      ? t.written
      : snapshot.status === 'partially_materialized'
        ? t.partial
        : snapshot.status === 'rejected'
          ? t.rejected
          : snapshot.status === 'withdrawn'
            ? t.withdrawn
            : snapshot.status === 'not_now'
              ? t.deferred
              : null
    : null;
  const participant = shown ?? item;
  const displayName =
    participant?.detail.displayName ??
    (isPersonMemoryProposalCardBlock(block) ? block.meta.subjectDisplayName : undefined);
  return (
    <article
      data-testid={`approval-item-${proposalId}`}
      className="space-y-3 rounded-xl border-l-4 p-3 text-sm"
      style={{ color: 'var(--shell-ink)', background: 'var(--shell-paper)', borderColor: 'var(--shell-primary)' }}
    >
      <header className="flex flex-wrap items-center gap-2 text-xs text-[var(--shell-muted)]">
        <span>{t.kind}</span>
        {participant ? <ApprovalMember catId={participant.requesterCatId} /> : null}
      </header>
      {typeof displayName === 'string' ? (
        <h3 className="font-semibold">
          {shown
            ? t.subject(
                displayName,
                Array.isArray(shown.detail.remainingDraftIds) ? shown.detail.remainingDraftIds.length : 0,
              )
            : t.person(displayName)}
        </h3>
      ) : null}
      {shown ? (
        <>
          <p className="text-xs text-[var(--shell-muted)]">{t.reversible}</p>
          <PersonMemoryChoices item={shown} read={read} />
        </>
      ) : block ? (
        <details>
          <summary className="shell-focusable cursor-pointer">{t.original}</summary>
          <CardBlock block={{ ...block, actions: undefined }} />
        </details>
      ) : null}
      {label ? (
        <output data-testid="person-memory-result" className="block">
          {label}
        </output>
      ) : null}
      {receipt && !snapshot?.undoReceipt ? (
        <p data-testid="person-memory-receipt">
          {t.receipt(
            receipt.materializedClaimIds.length,
            receipt.materializedRelationshipIds.length,
            receipt.materializedEventIds.length,
          )}
        </p>
      ) : null}
      {snapshot && ref ? (
        <PersonMemoryUndo
          proposalId={proposalId}
          messageId={ref.messageId}
          snapshot={snapshot}
          afterWrite={() => read.refresh()}
        />
      ) : null}
      {!read.source ? (
        <p role="status" className="text-xs">
          {read.checked ? t.unverified : t.checking}
        </p>
      ) : null}
      <div className="space-y-1">
        {host.originalPlaceAction}
        <button
          type="button"
          className="shell-focusable ml-auto block rounded px-2 py-1 text-xs"
          onClick={() => void read.refresh()}
        >
          {t.reread}
        </button>
      </div>
    </article>
  );
}

function PersonMemoryChoices({
  item,
  read,
}: {
  item: ApprovalHubItem;
  read: ReturnType<typeof usePersonMemoryProposal>;
}) {
  const actions = useApprovalItemActions(item, read.beforeWrite, async () => {
    await read.refresh();
  });
  return (
    <>
      <PersonMemoryClaimSelector
        item={item}
        onReject={() => void actions.handleReject()}
        beforeWrite={read.beforeWrite}
        afterWrite={async () => {
          await read.refresh();
        }}
        undoReceiptRequestId={read.source?.snapshot.undoReceipt?.requestId}
        blocked={read.checking || !read.source}
      />
      {actions.feedbackDialog}
    </>
  );
}
