import { isDeepStrictEqual } from 'node:util';
import { snapshotPluginProtocolData } from '../../../../plugin/carrier/plugin-protocol-data.js';
import type {
  BindCoveredMessageIdsResult,
  CreateTurnExecutionInput,
  CreateTurnExecutionResult,
  InterruptRunningTurnExecutionsInput,
  ITurnExecutionStore,
  TransitionTurnExecutionResult,
  TurnExecutionRecord,
  TurnExecutionSourceQuery,
  TurnExecutionTerminalInput,
  TurnOutputFenceVerdict,
} from '../../stores/ports/TurnExecutionStore.js';
import {
  authTerminalFromTurnExecution,
  callbackAuthDispositionFromTurnExecution,
} from './CallbackAuthTurnExecutionProjection.js';
import type { AuthTerminalCommitResult, InvocationRecord, InvocationRegistry } from './InvocationRegistry.js';
import { capturePublicInvocationAuth } from './public-invocation-auth-binding.js';
import { capturePublicOutputAuthProof, type PublicOutputAuthProof } from './public-output-terminal-decision.js';

export type ExistingAuthTerminalRepairResult = {
  kind:
    | 'repaired'
    | 'already_consistent'
    | 'child_running'
    | 'missing_child'
    | 'missing_auth'
    | 'terminal_conflict'
    | 'read_unavailable';
};

function sameRepairIdentity(id: string, child: TurnExecutionRecord, auth: PublicOutputAuthProof): boolean {
  if (child.invocationId !== id || auth.invocationId !== id) return false;
  if (
    !(['parentInvocationId', 'userId', 'threadId', 'catId'] as const).every((key) => {
      const value = child[key];
      return typeof value === 'string' && value.length > 0 && value === auth[key];
    })
  )
    return false;
  if (!Number.isFinite(child.startedAt) || child.startedAt < 0) return false;
  if (auth.publicInvocationBinding !== undefined) {
    capturePublicInvocationAuth(auth);
    const source = auth.publicInvocationBinding.carrier.sourceMessageId;
    return (
      child.executionKind === 'ordinary' &&
      child.queueCompletionPolicy === 'explicit_source' &&
      child.causal?.triggerMessageId === source &&
      isDeepStrictEqual(child.causal?.coveredMessageIds, [source]) &&
      child.causal?.freshnessSupplementId === undefined &&
      child.causal?.routingGuardReason === undefined
    );
  }
  return true;
}

function repairProjection(child: TurnExecutionRecord) {
  if (
    !['succeeded', 'failed', 'canceled', 'interrupted'].includes(child.status) ||
    child.endedAt === undefined ||
    !Number.isFinite(child.endedAt) ||
    child.endedAt < child.startedAt ||
    (child.status !== 'succeeded' && !child.terminalReason) ||
    (child.terminalReason !== undefined &&
      (typeof child.terminalReason !== 'string' || child.terminalReason.length === 0))
  )
    return undefined;
  return authTerminalFromTurnExecution(child);
}

function matchesProjection(
  auth: PublicOutputAuthProof,
  projection: ReturnType<typeof authTerminalFromTurnExecution>,
): boolean {
  return (
    auth.state === projection.disposition &&
    auth.endedAt === projection.endedAt &&
    auth.endReason === projection.endReason &&
    auth.terminalRef === projection.terminalRef
  );
}

export interface CallbackAuthStartupReconcileResult {
  migration: Awaited<ReturnType<InvocationRegistry['migrateLegacyRecords']>>;
  repairedCanonicalTerminals: number;
  revokedUnadmittedOrphans: number;
  conflicts: number;
}

/**
 * Callback-auth architecture cell coordinator.
 *
 * The wrapped TurnExecution store remains canonical. Terminal transitions are
 * committed there first and only then projected into callback-auth. Verify and
 * startup reconciliation repair the deliberately tolerated crash window.
 */
export class CallbackAuthTurnExecutionLifecycle implements ITurnExecutionStore {
  constructor(
    private readonly store: ITurnExecutionStore,
    private readonly registry: InvocationRegistry,
  ) {}

  createRunning(input: CreateTurnExecutionInput): CreateTurnExecutionResult | Promise<CreateTurnExecutionResult> {
    return this.store.createRunning(input);
  }

  bindCoveredMessageIds(
    invocationId: string,
    messageIds: readonly string[],
  ): BindCoveredMessageIdsResult | Promise<BindCoveredMessageIdsResult> {
    return this.store.bindCoveredMessageIds(invocationId, messageIds);
  }

  get(invocationId: string): TurnExecutionRecord | null | Promise<TurnExecutionRecord | null> {
    return this.store.get(invocationId);
  }

  listBySource(query: TurnExecutionSourceQuery): TurnExecutionRecord[] | Promise<TurnExecutionRecord[]> {
    return this.store.listBySource(query);
  }

  listByParent(parentInvocationId: string): TurnExecutionRecord[] | Promise<TurnExecutionRecord[]> {
    return this.store.listByParent(parentInvocationId);
  }

  listRunningByUser(userId: string): TurnExecutionRecord[] | Promise<TurnExecutionRecord[]> {
    return this.store.listRunningByUser(userId);
  }

  async transitionTerminal(
    invocationId: string,
    input: TurnExecutionTerminalInput,
  ): Promise<TransitionTurnExecutionResult> {
    const canonical = await this.store.transitionTerminal(invocationId, input);
    if (canonical.record && canonical.record.status !== 'running') {
      await this.registry.commitTerminal(authTerminalFromTurnExecution(canonical.record));
    }
    return canonical;
  }

  async interruptRunningBefore(
    cutoffStartedAt: number,
    input: InterruptRunningTurnExecutionsInput,
  ): Promise<TurnExecutionRecord[]> {
    const interrupted = await this.store.interruptRunningBefore(cutoffStartedAt, input);
    for (const record of interrupted) {
      await this.registry.commitTerminal(authTerminalFromTurnExecution(record));
    }
    return interrupted;
  }

  listResponsePending(): TurnExecutionRecord[] | Promise<TurnExecutionRecord[]> {
    return this.store.listResponsePending();
  }

  clearResponsePending(invocationId: string): void | Promise<void> {
    return this.store.clearResponsePending(invocationId);
  }

  settleOutputFence(
    invocationId: string,
    verdict: TurnOutputFenceVerdict,
  ): TurnExecutionRecord | null | Promise<TurnExecutionRecord | null> {
    return this.store.settleOutputFence(invocationId, verdict);
  }

  async failRegistration(invocationId: string, endedAt: number, reason: string): Promise<AuthTerminalCommitResult> {
    return this.registry.commitTerminal({
      invocationId,
      disposition: 'failed',
      endedAt,
      endReason: reason,
    });
  }

  /** Repair only an existing auth projection. Never mint credentials, recreate GC records, or mutate child truth. */
  async reconcileExistingTerminal(invocationId: string): Promise<ExistingAuthTerminalRepairResult> {
    if (typeof invocationId !== 'string' || !invocationId.trim()) return { kind: 'terminal_conflict' };
    const records = await this.readRepairRecords(invocationId);
    if (records.kind !== 'ready') return records;
    const { child, auth } = records;
    if (child.status === 'running') return { kind: 'child_running' };
    const projection = repairProjection(child);
    if (!projection) return { kind: 'terminal_conflict' };
    if (auth.state !== 'active')
      return { kind: matchesProjection(auth, projection) ? 'already_consistent' : 'terminal_conflict' };
    let result: AuthTerminalCommitResult;
    try {
      result = await this.registry.commitTerminal(projection);
    } catch {
      return { kind: 'read_unavailable' };
    }
    if (result.outcome === 'not_found') return { kind: 'missing_auth' };
    try {
      // Use the first-write winner returned by this operation, never a later unrelated read.
      const winner = capturePublicOutputAuthProof(result.record);
      if (!sameRepairIdentity(invocationId, child, winner) || !matchesProjection(winner, projection))
        return { kind: 'terminal_conflict' };
    } catch {
      return { kind: 'terminal_conflict' };
    }
    return { kind: result.outcome === 'committed' ? 'repaired' : 'already_consistent' };
  }

  private async readRepairRecords(
    invocationId: string,
  ): Promise<
    { kind: 'ready'; child: TurnExecutionRecord; auth: PublicOutputAuthProof } | ExistingAuthTerminalRepairResult
  > {
    let rawChild: TurnExecutionRecord | null;
    try {
      rawChild = await this.store.get(invocationId);
    } catch {
      return { kind: 'read_unavailable' };
    }
    if (rawChild === null) return { kind: 'missing_child' };
    let child: TurnExecutionRecord;
    try {
      child = snapshotPluginProtocolData(rawChild) as TurnExecutionRecord;
    } catch {
      return { kind: 'terminal_conflict' };
    }
    let rawAuth: InvocationRecord | null;
    try {
      rawAuth = await this.registry.getRecord(invocationId);
    } catch {
      return { kind: 'read_unavailable' };
    }
    if (rawAuth === null) return { kind: 'missing_auth' };
    let auth: PublicOutputAuthProof;
    try {
      auth = capturePublicOutputAuthProof(rawAuth);
      if (!sameRepairIdentity(invocationId, child, auth)) return { kind: 'terminal_conflict' };
    } catch {
      return { kind: 'terminal_conflict' };
    }
    return { kind: 'ready', child, auth };
  }

  async reconcileStartup(input: { processStartedAt: number }): Promise<CallbackAuthStartupReconcileResult> {
    const migration = await this.registry.migrateLegacyRecords();
    let repairedCanonicalTerminals = 0;
    let revokedUnadmittedOrphans = 0;
    let conflicts = 0;

    for (const authRecord of await this.registry.listActiveRecords()) {
      const outcome = await this.reconcileActiveRecord(authRecord, input.processStartedAt);
      if (outcome === 'repaired') repairedCanonicalTerminals += 1;
      if (outcome === 'revoked') revokedUnadmittedOrphans += 1;
      if (outcome === 'conflict') conflicts += 1;
    }

    return { migration, repairedCanonicalTerminals, revokedUnadmittedOrphans, conflicts };
  }

  private async reconcileActiveRecord(
    authRecord: InvocationRecord,
    processStartedAt: number,
  ): Promise<'unchanged' | 'repaired' | 'revoked' | 'conflict'> {
    const canonical = await this.store.get(authRecord.invocationId);
    if (!canonical) {
      if (authRecord.createdAt >= processStartedAt) return 'unchanged';
      const commit = await this.registry.commitTerminal({
        invocationId: authRecord.invocationId,
        disposition: 'revoked',
        endedAt: Date.now(),
        endReason: 'unadmitted_orphan',
      });
      return commit.outcome === 'committed' ? 'revoked' : 'unchanged';
    }
    if (canonical.status === 'running') return 'unchanged';
    const disposition = callbackAuthDispositionFromTurnExecution(canonical);
    const commit = await this.registry.commitTerminal(authTerminalFromTurnExecution(canonical));
    if (commit.outcome === 'committed') return 'repaired';
    if (commit.outcome === 'already_terminal' && commit.record.state !== disposition) return 'conflict';
    return 'unchanged';
  }
}
