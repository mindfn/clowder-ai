import { apiFetch } from '@/utils/api-client';
import type { SettledLookupInput } from './settled-lookup';
import { isRecord } from './thread-proposal-read';

/** Read-only proof: the producer's finalized binding and the exact, still available Thread owner must agree. */
export async function lookupCreatedThread(input: SettledLookupInput): Promise<string | null> {
  try {
    const proposalResponse = await apiFetch(
      `/api/proposals/${encodeURIComponent(input.proposalId)}`,
      { signal: input.signal },
      { afterCurrentGet: true },
    );
    if (!proposalResponse.ok) return null;
    const body: unknown = await proposalResponse.json();
    const proposal = isRecord(body) ? body.proposal : null;
    if (
      !isRecord(proposal) ||
      proposal.status !== 'approved' ||
      proposal.proposalId !== input.proposalId ||
      proposal.createdBy !== input.ownerUserId ||
      typeof proposal.createdThreadId !== 'string' ||
      !proposal.createdThreadId.trim()
    )
      return null;
    const threadResponse = await apiFetch(
      `/api/threads/${encodeURIComponent(proposal.createdThreadId)}`,
      { signal: input.signal },
      { afterCurrentGet: true },
    );
    if (!threadResponse.ok) return null;
    const thread: unknown = await threadResponse.json();
    return isRecord(thread) &&
      thread.id === proposal.createdThreadId &&
      thread.createdBy === input.ownerUserId &&
      thread.createdFromProposalId === input.proposalId
      ? proposal.createdThreadId
      : null;
  } catch {
    return null;
  }
}
