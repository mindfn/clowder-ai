import { isDeepStrictEqual } from 'node:util';
import { snapshotPluginProtocolData } from '../../../../plugin/carrier/plugin-protocol-data.js';
import { parseCursor } from '../../stores/cursor.js';
import type { StoredMessage } from '../../stores/ports/MessageStore.js';
import type { ITurnExecutionStore, TurnExecutionRecord } from '../../stores/ports/TurnExecutionStore.js';
import { parsePublicInvocationOutput } from '../../stores/public-invocation-output.js';
import type {
  PublicOutputLookupInput,
  PublicOutputLookupResult,
} from '../../stores/public-invocation-output-discovery.js';
import type { PublicOutputRecoveryRead } from '../../stores/public-invocation-output-recovery.js';
import {
  capturePublicQueueSelection,
  capturePublicQueueSource,
  decidePublicQueueOutput,
  exactPublicQueueChild,
  type PublicQueueClassification,
  type PublicQueueClassificationInput,
  type PublicQueueMessageReader,
  type PublicQueueSource,
} from './public-queue-output-classification.js';
import type { TerminalProofRecoveryBarrier } from './TerminalProofRecoveryBarrier.js';

interface Dependencies {
  readonly messageStore: PublicQueueMessageReader;
  readonly turnExecutionStore: Pick<ITurnExecutionStore, 'get'>;
  readonly proofBarrier: Pick<TerminalProofRecoveryBarrier, 'isReady'>;
}
const unavailable = (): PublicQueueClassification => ({ kind: 'deferred', reason: 'read_unavailable' });
const malformed = (): PublicQueueClassification => ({ kind: 'conflict', reason: 'malformed_record' });

/** One read-only classifier for live, startup and background Queue owners. Never launches, repairs or settles. */
export class PublicQueueOutputClassifier {
  constructor(private readonly deps: Dependencies) {}

  async classify(input: PublicQueueClassificationInput): Promise<PublicQueueClassification> {
    let selection: PublicQueueClassificationInput;
    try {
      selection = capturePublicQueueSelection(input);
    } catch {
      return { kind: 'conflict', reason: 'invalid_selection' };
    }
    let rawSource: StoredMessage | null;
    try {
      rawSource = await this.deps.messageStore.getById(selection.sourceMessageId);
    } catch {
      return unavailable();
    }
    let context: PublicQueueSource | PublicQueueClassification;
    try {
      context = capturePublicQueueSource(rawSource, selection);
    } catch {
      return malformed();
    }
    if ('kind' in context) return context;
    if (!context.childInvocationId) return { kind: 'unbound', reason: 'no_durable_child', source: context.source };
    if (!this.deps.proofBarrier.isReady()) return { kind: 'deferred', reason: 'startup_recovery_pending' };
    let rawChild: TurnExecutionRecord | null;
    try {
      rawChild = await this.deps.turnExecutionStore.get(context.childInvocationId);
    } catch {
      return unavailable();
    }
    let child: TurnExecutionRecord | null;
    try {
      child = snapshotPluginProtocolData(rawChild) as TurnExecutionRecord | null;
    } catch {
      return malformed();
    }
    const result = await this.readBound(selection, context.source, context.childInvocationId, child);
    let finalSource: StoredMessage | null;
    try {
      finalSource = await this.deps.messageStore.getById(selection.sourceMessageId);
    } catch {
      return unavailable();
    }
    try {
      if (!isDeepStrictEqual(snapshotPluginProtocolData(finalSource), context.source))
        return { kind: 'deferred', reason: 'source_changed_during_read' };
    } catch {
      return malformed();
    }
    // Bound decisions are provisional until the same canonical child is observed again.
    // A normal terminal transition during proof reads must not become a permanent conflict.
    // Keep this after the final source await; the consumer still owns its settlement CAS.
    let finalChild: TurnExecutionRecord | null;
    try {
      finalChild = await this.deps.turnExecutionStore.get(context.childInvocationId);
    } catch {
      return unavailable();
    }
    try {
      if (!isDeepStrictEqual(snapshotPluginProtocolData(finalChild), child))
        return { kind: 'deferred', reason: 'child_changed_during_read' };
    } catch {
      return malformed();
    }
    return { ...result, source: context.source, childInvocationId: context.childInvocationId };
  }

  private async readBound(
    selection: PublicQueueClassificationInput,
    source: StoredMessage,
    childId: string,
    child: TurnExecutionRecord | null,
  ): Promise<PublicQueueClassification> {
    if (!child) return { kind: 'conflict', reason: 'missing_canonical_child' };
    try {
      if (!exactPublicQueueChild(child, source, selection, childId))
        return { kind: 'conflict', reason: 'child_identity_mismatch' };
    } catch {
      return malformed();
    }
    const lookupInput: PublicOutputLookupInput = {
      userId: selection.userId,
      threadId: selection.threadId,
      sourceMessageId: source.id,
      childInvocationId: childId,
    };
    let lookup: PublicOutputLookupResult;
    try {
      lookup = await this.deps.messageStore.findPublicInvocationOutput(lookupInput);
    } catch {
      return unavailable();
    }
    try {
      lookup = snapshotPluginProtocolData(lookup) as PublicOutputLookupResult;
      if (!lookup || !['missing', 'unique', 'conflict'].includes(lookup.kind)) return malformed();
    } catch {
      return malformed();
    }
    if (lookup.kind === 'conflict') return { kind: 'conflict', reason: 'conflicting_output_mapping' };
    if (lookup.kind === 'missing')
      return child.status === 'running'
        ? { kind: 'deferred', reason: 'child_running' }
        : { kind: 'conflict', reason: 'missing_public_output' };
    if (lookup.kind !== 'unique' || typeof lookup.outputMessageId !== 'string') return malformed();
    const outputId = lookup.outputMessageId;
    let rawOutput: PublicOutputRecoveryRead;
    try {
      rawOutput = await this.deps.messageStore.readPublicInvocationOutputRecovery(outputId);
    } catch {
      return unavailable();
    }
    let output: PublicOutputRecoveryRead;
    let boundaryId: string | undefined;
    try {
      output = snapshotPluginProtocolData(rawOutput) as PublicOutputRecoveryRead;
      const observedId =
        output.kind === 'pending'
          ? output.expected.reservedId
          : output.kind === 'terminal' || output.kind === 'quarantined'
            ? output.message.id
            : outputId;
      if (observedId !== outputId) return { kind: 'conflict', reason: 'output_identity_mismatch' };
      if (output.kind === 'terminal') {
        const receipt = parsePublicInvocationOutput(output.message.extra?.publicOutputV1);
        if (receipt?.state === 'committed') boundaryId = parseCursor(receipt.boundary.cursor)?.id;
      }
    } catch {
      return malformed();
    }
    let boundary: StoredMessage | null = null;
    if (boundaryId) {
      let rawBoundary: StoredMessage | null;
      try {
        rawBoundary = await this.deps.messageStore.getById(boundaryId);
      } catch {
        return unavailable();
      }
      try {
        boundary = snapshotPluginProtocolData(rawBoundary) as StoredMessage | null;
      } catch {
        return malformed();
      }
    }
    let finalLookup: PublicOutputLookupResult;
    try {
      finalLookup = await this.deps.messageStore.findPublicInvocationOutput(lookupInput);
    } catch {
      return unavailable();
    }
    try {
      if (!isDeepStrictEqual(snapshotPluginProtocolData(finalLookup), lookup))
        return { kind: 'deferred', reason: 'output_mapping_changed_during_read' };
      return decidePublicQueueOutput(source, child, output, boundary);
    } catch {
      return malformed();
    }
  }
}
