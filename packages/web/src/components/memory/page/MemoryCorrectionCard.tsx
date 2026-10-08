import type { EventMemoryCorrectionProposalView } from '@cat-cafe/shared';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useCatData } from '@/hooks/useCatData';
import { apiFetch } from '@/utils/api-client';

export type MemoryCorrectionDecision = 'approve' | 'reject';
type Proposal = Pick<
  EventMemoryCorrectionProposalView,
  'proposalId' | 'status' | 'expectedRevision' | 'reason' | 'sourceCatId'
>;
const reasons = {
  unsupported_by_source: '原始来源不支持这条解释',
  outdated: '后来有了新情况',
  not_applicable_here: '这条解释不适用于当前情况',
};
const statuses = { pending: '待你决定', approving: '正在确认结果', approved: '已接受', rejected: '已拒绝' };
const unknownResult = (noun: string) => `结果尚未确认；可以重试这次决定，或重读${noun}。`;
function decisionFailure(response: { ok: boolean; status: number }, noun: string) {
  const uncertain = response.ok || response.status >= 500;
  return {
    uncertain,
    message: uncertain
      ? unknownResult(noun)
      : response.status === 409
        ? '记忆或建议已变更，请重读后再决定。'
        : '暂时不能处理这条建议，请重读。',
  };
}

/** Shared presentation only; each original lane supplies its own endpoint and receipt contract. */
export function MemoryCorrectionCard({
  proposal,
  revision,
  noun,
  endpoint,
  matchesReceipt,
  reread,
  children,
}: {
  proposal: Proposal;
  revision: string;
  noun: '事件' | '品味';
  endpoint: string;
  matchesReceipt: (body: unknown, proposalId: string, decision: MemoryCorrectionDecision) => boolean;
  reread: () => void;
  children: ReactNode;
}) {
  const { getCatById } = useCatData();
  const cat = getCatById(proposal.sourceCatId);
  const mounted = useRef(true);
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState<MemoryCorrectionDecision | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  function reportUnknown(decision: MemoryCorrectionDecision) {
    if (!mounted.current) return;
    setError(unknownResult(noun));
    setRetry(decision);
  }
  async function decide(decision: MemoryCorrectionDecision) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      const response = await apiFetch(`${endpoint}/${encodeURIComponent(proposal.proposalId)}/${decision}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const body: unknown = await response.json();
      if (!mounted.current) return;
      if (response.ok && matchesReceipt(body, proposal.proposalId, decision)) {
        reread();
        return;
      }
      const failure = decisionFailure(response, noun);
      setError(failure.message);
      setRetry(failure.uncertain ? decision : null);
    } catch {
      reportUnknown(decision);
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  const stale = proposal.expectedRevision !== revision;
  const pending = proposal.status === 'pending';
  return (
    <article className="space-y-3 rounded-lg bg-cafe-surface-sunken p-4">
      <p className="text-compact font-medium">
        {cat?.nickname || cat?.displayName || proposal.sourceCatId}的纠正建议 · {statuses[proposal.status]}
      </p>
      <p className="text-compact text-cafe-muted">{reasons[proposal.reason]}</p>
      {children}
      {pending && stale && <p className="text-compact text-cafe-muted">记忆已变更，这条建议尚未更新，不能直接接受。</p>}
      {error && (
        <p role="alert" className="text-compact">
          {error}
        </p>
      )}
      {pending && (
        <div className="flex flex-wrap gap-3 text-compact text-cafe-accent">
          <button type="button" disabled={busy || !!error || stale} onClick={() => void decide('approve')}>
            接受这条建议
          </button>
          <button type="button" disabled={busy || !!error} onClick={() => void decide('reject')}>
            拒绝这条建议
          </button>
        </div>
      )}
      {proposal.status === 'approving' && !error && (
        <button
          type="button"
          disabled={busy}
          onClick={() => void decide('approve')}
          className="text-compact text-cafe-accent"
        >
          重试这次接受
        </button>
      )}
      {(error || proposal.status === 'approving') && (
        <div className="flex gap-3 text-compact text-cafe-accent">
          {retry && (
            <button type="button" disabled={busy} onClick={() => void decide(retry)}>
              重试这次决定
            </button>
          )}
          <button type="button" disabled={busy} onClick={reread}>
            重读{noun}
          </button>
        </div>
      )}
    </article>
  );
}
