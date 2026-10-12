import { snapshotPluginProtocolData } from '../../../../plugin/carrier/plugin-protocol-data.js';
import type { AppendMessageInput, IMessageStore } from '../../stores/ports/MessageStore.js';
import { parsePublicInvocationOutput } from '../../stores/public-invocation-output.js';
import {
  capturePublicRecoveryCheckpoint,
  capturePublicRecoveryPage,
  type PublicOutputQuarantineReason,
  type PublicOutputRecoveryPage,
  type PublicOutputRecoveryRead,
  parsePublicOutputRecovery,
  parsePublicRecoveryCursor,
} from '../../stores/public-invocation-output-recovery.js';
import { capturePublicOutputTransition } from '../../stores/public-invocation-output-terminal.js';
import type { CallbackAuthTurnExecutionLifecycle } from './CallbackAuthTurnExecutionLifecycle.js';
import type {
  PublicInvocationOutputCommitCoordinator,
  PublicOutputCommitResult,
} from './PublicInvocationOutputCommitCoordinator.js';
import type { TerminalProofRecoveryBarrier } from './TerminalProofRecoveryBarrier.js';

interface Dependencies {
  messageStore: Pick<
    IMessageStore,
    | 'scanPendingPublicInvocationOutputs'
    | 'readPublicInvocationOutputRecovery'
    | 'quarantinePublicInvocationOutput'
    | 'getPublicInvocationOutputRecoveryCheckpoint'
    | 'advancePublicInvocationOutputRecoveryCheckpoint'
    | 'retireMissingPublicInvocationOutput'
  >;
  coordinator: Pick<PublicInvocationOutputCommitCoordinator, 'finalize'>;
  authLifecycle: Pick<CallbackAuthTurnExecutionLifecycle, 'reconcileExistingTerminal'>;
  proofBarrier: Pick<TerminalProofRecoveryBarrier, 'isReady'>;
}
export interface PublicOutputRecoveryOutcome {
  id: string;
  kind: 'committed' | 'abandoned' | 'quarantined' | 'missing' | 'malformed' | 'deferred' | 'conflict';
  reason?: string;
}
export type PublicOutputRecoverySweep =
  | { kind: 'completed'; exhausted: boolean; outcomes: PublicOutputRecoveryOutcome[] }
  | { kind: 'deferred' | 'conflict'; reason: string; outcomes: PublicOutputRecoveryOutcome[] };

function captureLimit(input: { readonly limit: number }): number {
  const row = snapshotPluginProtocolData(input) as { limit: number };
  if (!row || Object.keys(row).length !== 1 || !Object.hasOwn(row, 'limit'))
    throw new TypeError('Invalid recovery sweep');
  return capturePublicRecoveryPage(row).limit;
}
function capturePage(value: PublicOutputRecoveryPage, after: string | null, limit: number): PublicOutputRecoveryPage {
  const page = snapshotPluginProtocolData(value) as PublicOutputRecoveryPage;
  if (
    !page ||
    !Array.isArray(page.ids) ||
    page.ids.length > limit ||
    typeof page.exhausted !== 'boolean' ||
    new Set(page.ids).size !== page.ids.length ||
    page.ids.some((id) => typeof id !== 'string' || !id)
  )
    throw new Error('Invalid recovery page');
  if (!page.exhausted && (page.ids.length === 0 || !page.nextCursor)) throw new Error('Recovery page made no progress');
  if (page.nextCursor !== undefined && parsePublicRecoveryCursor(page.nextCursor) <= parsePublicRecoveryCursor(after))
    throw new Error('Recovery cursor regressed');
  return page;
}
function quarantineReason(result: PublicOutputCommitResult): PublicOutputQuarantineReason | undefined {
  if (result.kind !== 'conflict') return undefined;
  switch (result.reason) {
    case 'missing_canonical_child':
    case 'missing_terminal_proof':
    case 'identity_mismatch':
    case 'terminal_projection_mismatch':
      return result.reason;
    // Storage conflicts may be concurrent terminal/deletion winners. Never invent proof for them.
    default:
      return undefined;
  }
}

/** One bounded page per call. A completed sweep is not a claim that all pending outputs settled.
 * Discovery/checkpoint belong to the store; provider execution and Queue settlement are absent ports.
 */
export class PublicOutputRecoveryService {
  private running = false;
  constructor(private readonly deps: Dependencies) {}

  async sweep(input: { readonly limit: number }): Promise<PublicOutputRecoverySweep> {
    const limit = captureLimit(input);
    if (!this.deps.proofBarrier.isReady())
      return { kind: 'deferred', reason: 'startup_recovery_pending', outcomes: [] };
    if (this.running) return { kind: 'deferred', reason: 'sweep_in_progress', outcomes: [] };
    this.running = true;
    const outcomes: PublicOutputRecoveryOutcome[] = [];
    try {
      const raw = await this.deps.messageStore.getPublicInvocationOutputRecoveryCheckpoint();
      const checkpoint = snapshotPluginProtocolData(raw) as typeof raw;
      capturePublicRecoveryCheckpoint({ expectedRevision: checkpoint.revision, cursor: checkpoint.cursor });
      const page = capturePage(
        await this.deps.messageStore.scanPendingPublicInvocationOutputs({
          ...(checkpoint.cursor !== null ? { after: checkpoint.cursor } : {}),
          limit,
        }),
        checkpoint.cursor,
        limit,
      );
      for (const id of page.ids) outcomes.push(await this.recoverOne(id));
      const cursor = page.exhausted ? null : page.nextCursor;
      if (cursor === undefined) return { kind: 'conflict', reason: 'invalid_page', outcomes };
      try {
        const advance = await this.deps.messageStore.advancePublicInvocationOutputRecoveryCheckpoint({
          expectedRevision: checkpoint.revision,
          cursor,
        });
        if (advance.kind !== 'updated') return { kind: 'conflict', reason: 'checkpoint_conflict', outcomes };
      } catch {
        // The checkpoint may have applied. A later sweep reads the durable winner; no blind retry.
        return { kind: 'deferred', reason: 'checkpoint_unknown_applied', outcomes };
      }
      return { kind: 'completed', exhausted: page.exhausted, outcomes };
    } catch {
      return { kind: 'deferred', reason: 'read_unavailable', outcomes };
    } finally {
      this.running = false;
    }
  }

  private async recoverOne(id: string): Promise<PublicOutputRecoveryOutcome> {
    let read: PublicOutputRecoveryRead;
    try {
      read = await this.deps.messageStore.readPublicInvocationOutputRecovery(id);
    } catch {
      return { id, kind: 'deferred', reason: 'read_unavailable' };
    }
    if (read.kind === 'missing') {
      try {
        const retired = await this.deps.messageStore.retireMissingPublicInvocationOutput(id);
        return {
          id,
          kind: retired ? 'missing' : 'conflict',
          reason: retired ? 'missing_output' : 'absence_fence_conflict',
        };
      } catch {
        return { id, kind: 'deferred', reason: 'unknown_applied' };
      }
    }
    if (read.kind === 'malformed' || read.kind === 'quarantined') return { id, kind: read.kind, reason: read.reason };
    if (read.kind === 'terminal') {
      const state = parsePublicInvocationOutput(read.message.extra?.publicOutputV1)?.state;
      return state === 'committed' || state === 'abandoned'
        ? { id, kind: state }
        : { id, kind: 'malformed', reason: 'invalid_terminal_receipt' };
    }
    return this.recoverPending(id, read.expected);
  }

  private async recoverPending(id: string, rawExpected: AppendMessageInput): Promise<PublicOutputRecoveryOutcome> {
    let expected: AppendMessageInput;
    try {
      expected = capturePublicOutputTransition(id, { expected: rawExpected, nextState: 'committed' }).expected;
    } catch {
      return { id, kind: 'malformed', reason: 'append_commitment_mismatch' };
    }
    let decision: PublicOutputCommitResult;
    try {
      decision = await this.deps.coordinator.finalize({ expected });
      if (decision.kind === 'deferred' && decision.reason === 'auth_reconciliation_pending') {
        const child = expected.extra?.publicOutputV1?.childInvocationId;
        if (!child) return { id, kind: 'malformed', reason: 'append_commitment_mismatch' };
        const repair = await this.deps.authLifecycle.reconcileExistingTerminal(child);
        if (repair.kind === 'read_unavailable' || repair.kind === 'child_running')
          return { id, kind: 'deferred', reason: repair.kind };
        // Exactly one repair and one reread, using the same frozen append commitment.
        decision = await this.deps.coordinator.finalize({ expected });
      }
    } catch {
      return { id, kind: 'deferred', reason: 'unknown_applied' };
    }
    const reason = quarantineReason(decision);
    if (reason) return this.quarantine(id, expected, reason);
    return { id, kind: decision.kind, ...('reason' in decision ? { reason: decision.reason } : {}) };
  }

  private async quarantine(
    id: string,
    expected: AppendMessageInput,
    reason: PublicOutputQuarantineReason,
  ): Promise<PublicOutputRecoveryOutcome> {
    try {
      const result = await this.deps.messageStore.quarantinePublicInvocationOutput(id, { expected, reason });
      if (result.kind === 'updated' || result.kind === 'existing') {
        const companion = parsePublicOutputRecovery(result.message.extra?.publicOutputRecoveryV1);
        if (result.message.id !== id || companion?.state !== 'quarantined')
          return { id, kind: 'conflict', reason: 'invalid_quarantine_receipt' };
        return { id, kind: 'quarantined', reason: companion.reason };
      }
      if (result.kind === 'terminal_won') {
        const state = parsePublicInvocationOutput(result.message.extra?.publicOutputV1)?.state;
        return state === 'committed' || state === 'abandoned'
          ? { id, kind: state }
          : { id, kind: 'conflict', reason: 'invalid_terminal_receipt' };
      }
      return { id, kind: 'conflict', reason: 'quarantine_conflict' };
    } catch {
      return { id, kind: 'deferred', reason: 'unknown_applied' };
    }
  }
}
