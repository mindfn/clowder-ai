/**
 * F167 × F322: Real `TaskApprovedDelegateProvider` backed by the
 * authoritative proposal store.
 *
 * Architecture:
 *   - `proposalStore.get(proposalId)` verifies proposal status + lifecycle
 *   - `bindingProvider` maps a specific task → every independently approved
 *     proposal that grants delegation for it (task-level scoping, not thread-pooled)
 *   - Authorized delegate catIds come from `proposal.preferredCats` —
 *     the explicit execution target set at proposal creation / operator approval,
 *     not the current thread roster (which may include reviewers, coordinators,
 *     or other cats who joined after approval).
 *
 * Fail-closed at every step: missing binding, missing/rejected/withdrawn
 * proposal, thread mismatch, tenant mismatch, owner change since approval,
 * or empty preferredCats all yield empty delegates.
 */

import type {
  ApprovedDelegate,
  DevelopmentScopeSnapshot,
  TaskApprovedDelegateProvider,
} from './action-subject-delegate-contract.js';
import { sameDevelopmentScopeSnapshot } from './action-subject-delegate-contract.js';

/**
 * Maps a task to a proposal that grants delegation for it, along with
 * the ownerCatId that was current when the delegation was approved.
 *
 * This binding is the bridge between the task layer (which knows task IDs)
 * and the proposal layer (which knows thread-level approvals). Without
 * this binding, the provider cannot prove task-level delegation → fail closed.
 *
 * The `approvedUnderOwner` field enables owner-change invalidation (P1-2):
 * if the task's current owner differs from the owner at approval time,
 * the delegation is no longer proven valid.
 */
export interface DelegateProposalBinding {
  readonly proposalId: string;
  readonly approvedUnderOwner: string;
}

/**
 * Resolves the delegation bindings for a specific task. Implementations
 * typically query a task metadata index or workflow state.
 *
 * `taskThreadId` is the thread where the task lives (the parent/source
 * thread), not the child thread. The caller (ProposalStoreDelegateProvider)
 * already resolved the task and passes this through to avoid redundant
 * lookups.
 */
export interface DelegateBindingProvider {
  getBindingsForTask(
    taskId: string,
    taskThreadId: string,
    tenantScope: string,
  ): Promise<ReadonlyArray<DelegateProposalBinding>>;
}

/**
 * Minimal proposal shape consumed by the provider. Matches a subset of
 * `ThreadProposal` from `@cat-cafe/shared` — the provider does not need
 * the full proposal type, only the fields required for verification.
 *
 * `preferredCats` is the authoritative list of cats explicitly approved
 * for execution in the child thread. It is set at proposal creation and
 * may be overridden by the operator at approval time. Only cats in this list
 * receive delegate standing — later thread participants (reviewers,
 * coordinators) do NOT gain delegation by joining.
 *
 * When `preferredCats` is empty or absent, no cats have been explicitly
 * authorized → fail closed.
 */
export interface ProposalSnapshot {
  readonly proposalId: string;
  readonly status: string;
  readonly createdThreadId?: string;
  readonly sourceThreadId: string;
  readonly createdBy: string;
  readonly preferredCats?: ReadonlyArray<string>;
  /** F167 R5: immutable scope snapshot from creation time. Absent → no delegate authority. */
  readonly approvedDevelopmentScope?: DevelopmentScopeSnapshot;
}

export class ProposalStoreDelegateProvider implements TaskApprovedDelegateProvider {
  constructor(
    private readonly proposalStore: { get(id: string): Promise<ProposalSnapshot | null> },
    private readonly bindingProvider: DelegateBindingProvider,
  ) {}

  async getForTask(
    taskId: string,
    taskThreadId: string,
    currentOwnerCatId: string,
    tenantScope: string,
    currentDevelopmentScope?: DevelopmentScopeSnapshot,
  ): Promise<ReadonlyArray<ApprovedDelegate>> {
    // Step 1: Find every independently approved delegation binding for this
    // specific task. Thread proposals are durable approvals and the current
    // proposal lifecycle has no approved→revoked transition, so sequential
    // child approvals may legitimately coexist.
    const bindings = await this.bindingProvider.getBindingsForTask(taskId, taskThreadId, tenantScope);

    const delegateGroups = await Promise.all(
      bindings.map(async (binding): Promise<ReadonlyArray<ApprovedDelegate>> => {
        // Step 2 (P1-2): Owner changes invalidate each approval independently.
        if (binding.approvedUnderOwner !== currentOwnerCatId) return [];

        // Steps 3-6: Re-read and verify each proposal from authoritative truth.
        const proposal = await this.proposalStore.get(binding.proposalId);
        if (!proposal || proposal.status !== 'approved') return [];
        const createdThreadId = proposal.createdThreadId;
        if (!createdThreadId) return [];
        if (proposal.sourceThreadId !== taskThreadId) return [];
        if (proposal.createdBy !== tenantScope) return [];

        // Step 7 (R5): Scope drift invalidates only the affected approval.
        if (!sameDevelopmentScopeSnapshot(proposal.approvedDevelopmentScope, currentDevelopmentScope)) return [];

        // Step 8: preferredCats are the exact approved execution targets.
        const authorizedCats = proposal.preferredCats;
        if (!authorizedCats || authorizedCats.length === 0) return [];

        return authorizedCats.map((catId) => ({
          catId,
          threadId: createdThreadId,
          evidenceRef: `proposal:${binding.proposalId}:approved:thread:${createdThreadId}:cat:${catId}`,
        }));
      }),
    );

    return delegateGroups.flat();
  }
}

/**
 * Minimal proposal shape returned by listing. Only the fields needed for
 * binding resolution — not the full ThreadProposal.
 */
export interface ProposalListItem {
  readonly proposalId: string;
  readonly status: string;
  readonly createdThreadId?: string;
  readonly createdBy: string;
  readonly sourceCatId: string;
  /** F167 × F322: task binding — absent on legacy proposals. */
  readonly subjectTaskId?: string;
}

/**
 * F167 × F322: Production `DelegateBindingProvider` backed by the thread→
 * proposal chain in the authoritative proposal store.
 *
 * Resolution path:
 *   1. `proposalLister.listAllByThread(taskThreadId)` returns the complete
 *      authority set raised from the task's parent thread. Product-list
 *      windows must never silently revoke an older approval.
 *   2. Filter to proposals that are `approved` with a `createdThreadId`
 *      AND whose `subjectTaskId` matches the requested `taskId`.
 *      This ensures task-level isolation: proposals for task A cannot
 *      authorize delegation for task B in the same thread.
 *   3. Verify tenant independently for every match. A different-tenant
 *      proposal grants no authority and cannot suppress valid approvals.
 *   4. Return every independently valid binding. The eventual request is
 *      authorized only when its exact (catId, childThreadId) pair matches a
 *      fully revalidated proposal-backed delegate.
 *   5. `approvedUnderOwner` is set to `proposal.sourceCatId` — the cat
 *      that proposed the delegation. ProposalStoreDelegateProvider.getForTask
 *      Step 2 compares this against the task's current ownerCatId — if the
 *      owner changed from the proposer, the delegation is invalidated (P1-2).
 *
 * Fail-closed per candidate: no proposals or no valid task-matching proposals
 * yield an empty list; tenant mismatch and missing child threads exclude only
 * those candidates. Legacy proposals without `subjectTaskId` are excluded —
 * they cannot prove task-level delegation.
 */
export class ThreadDelegateBindingProvider implements DelegateBindingProvider {
  constructor(
    private readonly proposalLister: {
      listAllByThread(threadId: string): Promise<ReadonlyArray<ProposalListItem>>;
    },
  ) {}

  async getBindingsForTask(
    taskId: string,
    taskThreadId: string,
    tenantScope: string,
  ): Promise<ReadonlyArray<DelegateProposalBinding>> {
    // Step 1: List all proposals from the task's parent thread.
    const proposals = await this.proposalLister.listAllByThread(taskThreadId);

    // Step 2: Filter to approved proposals that:
    //   a) Created a child thread (createdThreadId is set)
    //   b) Are explicitly bound to THIS task via subjectTaskId
    // Proposals without subjectTaskId are legacy — they cannot prove
    // task-level delegation and are excluded (fail closed).
    const taskBound = proposals.filter(
      (p) => p.status === 'approved' && p.createdThreadId && p.subjectTaskId === taskId && p.createdBy === tenantScope,
    );

    // Steps 3-5: Every surviving proposal is an independent binding. The
    // downstream provider re-reads each full proposal and the standing check
    // still requires an exact delegate cat/thread pair.
    return taskBound.map((proposal) => ({
      proposalId: proposal.proposalId,
      approvedUnderOwner: proposal.sourceCatId,
    }));
  }
}
