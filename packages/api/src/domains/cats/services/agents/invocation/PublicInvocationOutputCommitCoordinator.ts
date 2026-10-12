import { snapshotPluginProtocolData } from '../../../../plugin/carrier/plugin-protocol-data.js';
import type { AppendMessageInput, IMessageStore, StoredMessage } from '../../stores/ports/MessageStore.js';
import type { ITurnExecutionStore, TurnExecutionRecord } from '../../stores/ports/TurnExecutionStore.js';
import { parsePublicInvocationOutput } from '../../stores/public-invocation-output.js';
import { assertPublicOutputReplay } from '../../stores/public-invocation-output-append.js';
import type { PublicOutputTransitionResult } from '../../stores/public-invocation-output-terminal.js';
import { capturePublicOutputTransition } from '../../stores/public-invocation-output-terminal.js';
import type { InvocationRecord, InvocationRegistry } from './InvocationRegistry.js';
import {
  capturePublicOutputAuthProof,
  decidePublicOutputTerminal,
  type PublicOutputAuthProof,
  type PublicOutputTerminalDecision,
} from './public-output-terminal-decision.js';
import type { TerminalProofRecoveryBarrier } from './TerminalProofRecoveryBarrier.js';

interface Dependencies {
  readonly messageStore: Pick<IMessageStore, 'getById' | 'transitionPublicInvocationOutput'>;
  readonly turnExecutionStore: Pick<ITurnExecutionStore, 'get'>;
  readonly registry: Pick<InvocationRegistry, 'getRecord'>;
  readonly proofBarrier: Pick<TerminalProofRecoveryBarrier, 'isReady'>;
}
export type PublicOutputCommitResult =
  | { kind: 'committed' | 'abandoned'; message: StoredMessage }
  | Exclude<PublicOutputTerminalDecision, { kind: 'committed' | 'abandoned' }>
  | { kind: 'deferred'; reason: 'startup_recovery_pending' | 'read_unavailable' | 'unknown_applied' }
  | { kind: 'conflict'; reason: 'output_mismatch' | 'storage_conflict' | 'invalid_storage_receipt' };

function capture(input: { readonly expected: AppendMessageInput }): AppendMessageInput {
  try {
    const row = snapshotPluginProtocolData(input) as { expected: AppendMessageInput };
    if (
      !row ||
      typeof row !== 'object' ||
      Array.isArray(row) ||
      Object.keys(row).length !== 1 ||
      !Object.hasOwn(row, 'expected')
    )
      throw new Error('invalid input');
    const id = row.expected.reservedId;
    if (!id || !row.expected.extra?.stream?.invocationId) throw new Error('missing output identity');
    return capturePublicOutputTransition(id, { expected: row.expected, nextState: 'committed' }).expected;
  } catch {
    throw new TypeError('Invalid public output coordinator input');
  }
}
function outputState(expected: AppendMessageInput, current: StoredMessage | null) {
  if (!current) return undefined;
  try {
    assertPublicOutputReplay(expected, current);
    return parsePublicInvocationOutput(current.extra?.publicOutputV1)?.state;
  } catch {
    return undefined;
  }
}

/**
 * Read-only lifecycle authorization followed by the exact storage CAS. Missing terminal proof is
 * a conflict for recovery quarantine, never permission to restart a provider or consume a source.
 */
export class PublicInvocationOutputCommitCoordinator {
  constructor(private readonly deps: Dependencies) {}

  async finalize(input: { readonly expected: AppendMessageInput }): Promise<PublicOutputCommitResult> {
    const expected = capture(input);
    const id = expected.reservedId as string;
    let current: StoredMessage | null;
    try {
      current = await this.deps.messageStore.getById(id);
    } catch {
      return { kind: 'deferred', reason: 'read_unavailable' };
    }
    const state = outputState(expected, current);
    if (!state) return { kind: 'conflict', reason: 'output_mismatch' };
    // This durable read outlives callback tombstones. Do not issue a potentially writing CAS:
    // deletion/recreation after this read must not let old proof promote a new pending row.
    if (state !== 'pending_terminal') return { kind: state, message: structuredClone(current as StoredMessage) };
    const decision = await this.readDecision(expected);
    if (decision.kind !== 'committed' && decision.kind !== 'abandoned') return decision;
    return this.transition(expected, decision.kind);
  }

  private async readDecision(
    expected: AppendMessageInput,
  ): Promise<
    PublicOutputTerminalDecision | { kind: 'deferred'; reason: 'startup_recovery_pending' | 'read_unavailable' }
  > {
    if (!this.deps.proofBarrier.isReady()) return { kind: 'deferred', reason: 'startup_recovery_pending' };
    const childId = expected.extra?.publicOutputV1?.childInvocationId as string;
    let child: TurnExecutionRecord | null;
    let auth: PublicOutputAuthProof | null;
    let rawChild: TurnExecutionRecord | null;
    try {
      rawChild = await this.deps.turnExecutionStore.get(childId);
    } catch {
      return { kind: 'deferred', reason: 'read_unavailable' };
    }
    try {
      // Freeze a returned record before the next storage await; mutable adapters cannot
      // retroactively upgrade the decision made from this read.
      child = rawChild === null ? null : (snapshotPluginProtocolData(rawChild) as TurnExecutionRecord);
    } catch {
      return { kind: 'conflict', reason: 'identity_mismatch' };
    }
    let rawAuth: InvocationRecord | null;
    try {
      rawAuth = await this.deps.registry.getRecord(childId);
    } catch {
      return { kind: 'deferred', reason: 'read_unavailable' };
    }
    try {
      auth = rawAuth === null ? null : capturePublicOutputAuthProof(rawAuth);
    } catch {
      return { kind: 'conflict', reason: 'identity_mismatch' };
    }
    return decidePublicOutputTerminal(expected, child, auth);
  }

  private async transition(
    expected: AppendMessageInput,
    nextState: 'committed' | 'abandoned',
  ): Promise<PublicOutputCommitResult> {
    let result: PublicOutputTransitionResult;
    try {
      result = await this.deps.messageStore.transitionPublicInvocationOutput(expected.reservedId as string, {
        expected,
        nextState,
      });
    } catch {
      // Storage may have applied before its acknowledgement failed. Retry only this exact output.
      return { kind: 'deferred', reason: 'unknown_applied' };
    }
    if (result.kind !== 'updated' && result.kind !== 'existing')
      return { kind: 'conflict', reason: 'storage_conflict' };
    if (outputState(expected, result.message) !== nextState)
      return { kind: 'conflict', reason: 'invalid_storage_receipt' };
    return { kind: nextState, message: structuredClone(result.message) };
  }
}
