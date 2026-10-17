'use client';
import type { UnifiedAttentionVisibleApproval } from '@cat-cafe/shared';
import { useShellCopy } from '../shell/shell-copy';
import { PersonMemoryUndo } from './PersonMemoryUndo';
import { personMemoryCopy } from './person-memory.shell-copy';
import { usePersonMemoryProposal } from './use-person-memory-proposal';

/** Decision results keep the producer's exact reversible receipt even after the pending row retires. */
export function PersonMemoryRetainedReceipt({ approval }: { approval: UnifiedAttentionVisibleApproval }) {
  const t = useShellCopy(personMemoryCopy);
  const ref = approval.navigation.state === 'anchored' ? approval.navigation.approvalCardRef : undefined;
  const read = usePersonMemoryProposal(approval.proposalId, ref);
  const snapshot = read.source?.snapshot,
    receipt = snapshot?.decisionReceipt;
  if (!snapshot || !ref) return <p>{t.unverified}</p>;
  return (
    <div className="space-y-2">
      {!snapshot.undoReceipt ? (
        <output>
          {snapshot.status === 'materialized'
            ? t.written
            : snapshot.status === 'rejected'
              ? t.rejected
              : snapshot.status === 'partially_materialized'
                ? t.partial
                : snapshot.status === 'withdrawn'
                  ? t.withdrawn
                  : t.deferred}
        </output>
      ) : null}
      {snapshot.undoReceipt ? (
        <output data-testid="person-memory-undo-result">{t.undone}</output>
      ) : receipt ? (
        <p>
          {t.receipt(
            receipt.materializedClaimIds.length,
            receipt.materializedRelationshipIds.length,
            receipt.materializedEventIds.length,
          )}
        </p>
      ) : null}
      <PersonMemoryUndo
        proposalId={approval.proposalId}
        messageId={ref.messageId}
        snapshot={snapshot}
        afterWrite={() => read.refresh()}
      />
    </div>
  );
}
