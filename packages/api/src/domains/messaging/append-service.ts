/**
 * Plugin Messaging — messaging.appendElements (K-1 / F258, AC-4, §4d)
 *
 * Atomicity: per-message owner-token lock serializes appends; the
 * read-check-write on extra.pluginMessage happens entirely inside the lock.
 * baseRevision gives callers optimistic concurrency on top (INV-10).
 *
 * Idempotency (INV-12): ledger key (instance, messageId, operationId) +
 * appendOps records INSIDE the lock cover the crash window between write and
 * settle. Each record stores the operation's elementIds, so replays rebuild
 * the receipt and the re-emitted event from the PERSISTED elements — a retry
 * that reuses an operationId with different elements is rejected, never
 * echoed back as applied.
 *
 * Provenance (INV-7): appended elements are stamped 'inference' unless they
 * explicitly claim a status equal to their derivation source's status —
 * appends can never elevate epistemic standing, and omission never inherits
 * the message-level status silently.
 *
 * Applied-revision derivation: send fixes revision 1 and each append bumps by
 * exactly 1, so the op at appendOps index i produced revision i+2 — derivable,
 * no extra state (派生值规则).
 *
 * Cumulative bounds (D-6): per-operation bounds alone would let a plugin grow
 * one message without limit through fresh operationIds; maxElementsPerMessage
 * and maxAppendOpsPerMessage cap the whole document (fail-closed).
 */

import type { IMessageStore, StoredMessage } from '../cats/services/stores/ports/MessageStore.js';
import { payloadBytes, sameIdSet, stampAppendedElements } from './append-elements.js';
import type { AppendElementsInput, AppendReceipt, MessageElement, PluginCallContext } from './contract/types.js';
import { MESSAGING_BOUNDS, MessagingError } from './contract/types.js';
import { validateAppendInput } from './contract/validate.js';
import { type AppendOpRecord, type PluginMessageExtra, readPluginMessageExtra } from './envelope.js';
import type { HandleService } from './handles.js';
import type { MessagingLedger } from './ledger.js';
import type { AppendLock, EventLogStore } from './stores/ports.js';
import { clampRetention } from './stores/ports.js';

export const APPEND_LOCK_TTL_MS = 5_000;

export interface AppendServiceDeps {
  readonly messageStore: IMessageStore;
  readonly ledger: MessagingLedger;
  readonly handles: HandleService;
  readonly events: EventLogStore;
  readonly appendLock: AppendLock;
  readonly retentionCount?: number;
}

interface ReconciledAppendState {
  readonly message: StoredMessage;
  readonly plugin: PluginMessageExtra;
  readonly sequenceByOperation: ReadonlyMap<string, number>;
}

export class AppendService {
  private readonly deps: AppendServiceDeps;
  private readonly retentionCount: number;

  constructor(deps: AppendServiceDeps) {
    this.deps = deps;
    this.retentionCount = clampRetention(deps.retentionCount);
  }

  async appendElements(ctx: PluginCallContext, input: unknown): Promise<AppendReceipt> {
    const parsed = validateAppendInput(input);
    const target = await this.deps.handles.resolveForAppend(ctx.pluginInstanceId, parsed.handle);
    const messageId = target.messageId;
    const claim = await this.deps.ledger.claimAppend(ctx.pluginInstanceId, messageId, parsed.operationId);
    if (claim.status === 'settled') return claim.receipt;
    if (claim.status === 'inflight') {
      throw new MessagingError('RETRYABLE_INFLIGHT', 'an append with this operationId is in flight — retry later');
    }

    try {
      const token = await this.deps.appendLock.acquire(messageId, APPEND_LOCK_TTL_MS);
      if (token === null) {
        throw new MessagingError('RETRYABLE_INFLIGHT', 'message is being appended by another operation — retry later');
      }
      try {
        const receipt = await this.applyLocked(ctx, parsed, messageId);
        await this.deps.ledger.settleAppend(
          ctx.pluginInstanceId,
          messageId,
          parsed.operationId,
          claim.claimToken,
          receipt,
        );
        return receipt;
      } finally {
        await this.deps.appendLock.release(messageId, token);
      }
    } catch (err) {
      await this.deps.ledger.releaseAppend(ctx.pluginInstanceId, messageId, parsed.operationId, claim.claimToken);
      throw err;
    }
  }

  /** Runs inside the per-message lock. */
  private async applyLocked(
    ctx: PluginCallContext,
    parsed: AppendElementsInput,
    messageId: string,
  ): Promise<AppendReceipt> {
    const msg = await this.deps.messageStore.getById(messageId);
    if (!msg || msg.deletedAt !== undefined || msg._tombstone) {
      throw new MessagingError('NOT_FOUND', `message ${messageId} not found`);
    }
    const plugin = readPluginMessageExtra(msg);
    if (!plugin) {
      throw new MessagingError('PERMISSION', 'appendElements targets a non-plugin message');
    }
    if (plugin.instanceId !== ctx.pluginInstanceId) {
      throw new MessagingError('PERMISSION', 'message belongs to a different plugin instance (INV-8)');
    }

    // INV-12 replay guard inside the lock: write landed, settle crashed.
    const replayIndex = plugin.appendOps.findIndex((op) => op.operationId === parsed.operationId);
    if (replayIndex >= 0) {
      const record = plugin.appendOps[replayIndex] as AppendOpRecord;
      const retryIds = parsed.elements.map((el) => el.elementId);
      if (!sameIdSet(retryIds, record.elementIds)) {
        throw new MessagingError('VALIDATION', 'operationId was already applied with a different element set', {
          operationId: parsed.operationId,
        });
      }
      const reconciled = await this.reconcilePersistedAppendEvents(msg, plugin, true);
      const persisted = reconciled.plugin.elements.filter((el) => record.elementIds.includes(el.elementId));
      return this.makeReceipt(
        reconciled.message,
        parsed,
        replayIndex + 2,
        persisted,
        reconciled.sequenceByOperation.get(parsed.operationId),
      );
    }

    if (parsed.baseRevision !== undefined && parsed.baseRevision !== plugin.revision) {
      throw new MessagingError('CONFLICT', 'baseRevision does not match the current revision (INV-10)', {
        baseRevision: parsed.baseRevision,
        currentRevision: plugin.revision,
      });
    }

    // D-6 cumulative caps: a message can never grow without bound across appends.
    if (plugin.appendOps.length + 1 > MESSAGING_BOUNDS.maxAppendOpsPerMessage) {
      throw new MessagingError(
        'VALIDATION',
        `message exceeds ${MESSAGING_BOUNDS.maxAppendOpsPerMessage} append operations`,
      );
    }
    if (plugin.elements.length + parsed.elements.length > MESSAGING_BOUNDS.maxElementsPerMessage) {
      throw new MessagingError(
        'VALIDATION',
        `message would exceed ${MESSAGING_BOUNDS.maxElementsPerMessage} total elements`,
      );
    }
    if (payloadBytes(plugin.elements) + payloadBytes(parsed.elements) > MESSAGING_BOUNDS.maxTotalPayloadBytes) {
      throw new MessagingError(
        'VALIDATION',
        `message would exceed ${MESSAGING_BOUNDS.maxTotalPayloadBytes} total payload bytes`,
      );
    }

    const existingIds = new Set(plugin.elements.map((el) => el.elementId));
    const stamped = stampAppendedElements(parsed, plugin, existingIds);
    const newRevision = plugin.revision + 1;

    // The TTL lock can be taken over after a predecessor persisted its message
    // revision but before it emitted the matching event. Treat appendOps as a
    // tiny durable outbox: a successor repairs every committed predecessor in
    // revision order before it is allowed to persist its own revision.
    const reconciled = await this.reconcilePersistedAppendEvents(msg, plugin, false);
    const currentMessage = reconciled.message;
    const currentPlugin = reconciled.plugin;

    const updated: PluginMessageExtra = {
      ...currentPlugin,
      revision: newRevision,
      elements: [...currentPlugin.elements, ...stamped],
      appendOps: [
        ...currentPlugin.appendOps,
        {
          operationId: parsed.operationId,
          elementIds: stamped.map((el) => el.elementId),
          ...(parsed.baseRevision !== undefined ? { baseRevision: parsed.baseRevision } : {}),
        },
      ],
    };
    const written = await this.deps.messageStore.updatePluginMessage(
      currentMessage.id,
      updated as unknown as NonNullable<NonNullable<StoredMessage['extra']>['pluginMessage']>,
      currentPlugin.revision,
    );
    if (!written) {
      const current = await this.deps.messageStore.getById(messageId);
      if (current) {
        throw new MessagingError('CONFLICT', 'message revision changed while the append lock lease was held');
      }
      throw new MessagingError('NOT_FOUND', `message ${messageId} disappeared during append`);
    }

    const writtenPlugin = readPluginMessageExtra(written);
    if (!writtenPlugin) throw new MessagingError('VALIDATION', 'persisted append lost its canonical plugin payload');
    const appendSequence = await this.emitAppendEvent(
      written,
      parsed.operationId,
      newRevision,
      stamped,
      parsed.baseRevision,
    );
    await this.persistOutputWatermark(written, writtenPlugin, appendSequence);
    return this.makeReceipt(written, parsed, newRevision, stamped, appendSequence);
  }

  private async reconcilePersistedAppendEvents(
    msg: StoredMessage,
    plugin: PluginMessageExtra,
    force: boolean,
  ): Promise<ReconciledAppendState> {
    if (!force && plugin.outputRevision === plugin.revision && plugin.outputSequence !== undefined) {
      return { message: msg, plugin, sequenceByOperation: new Map() };
    }
    const sequenceByOperation = new Map<string, number>();
    let maxSequence: number | undefined;
    for (let index = 0; index < plugin.appendOps.length; index += 1) {
      const record = plugin.appendOps[index] as AppendOpRecord;
      const elements = plugin.elements.filter((element) => record.elementIds.includes(element.elementId));
      const sequence = await this.emitAppendEvent(msg, record.operationId, index + 2, elements, record.baseRevision);
      if (sequence !== undefined) {
        sequenceByOperation.set(record.operationId, sequence);
        maxSequence = Math.max(maxSequence ?? sequence, sequence);
      }
    }
    const marked = await this.persistOutputWatermark(msg, plugin, maxSequence);
    return { ...marked, sequenceByOperation };
  }

  private async persistOutputWatermark(
    msg: StoredMessage,
    plugin: PluginMessageExtra,
    sequence: number | undefined,
  ): Promise<{ readonly message: StoredMessage; readonly plugin: PluginMessageExtra }> {
    if (sequence === undefined) return { message: msg, plugin };
    const marked: PluginMessageExtra = {
      ...plugin,
      outputRevision: plugin.revision,
      outputSequence: sequence,
    };
    const written = await this.deps.messageStore.updatePluginMessage(
      msg.id,
      marked as unknown as NonNullable<NonNullable<StoredMessage['extra']>['pluginMessage']>,
      plugin.revision,
    );
    if (!written) {
      const current = await this.deps.messageStore.getById(msg.id);
      if (current) {
        const currentPlugin = readPluginMessageExtra(current);
        if (
          currentPlugin &&
          currentPlugin.outputRevision === currentPlugin.revision &&
          currentPlugin.outputSequence !== undefined
        ) {
          return { message: current, plugin: currentPlugin };
        }
        throw new MessagingError('CONFLICT', 'message revision changed before output watermark persisted');
      }
      throw new MessagingError('NOT_FOUND', `message ${msg.id} disappeared before output watermark persisted`);
    }
    const persisted = readPluginMessageExtra(written);
    if (!persisted)
      throw new MessagingError('VALIDATION', 'output watermark persistence produced invalid plugin state');
    return { message: written, plugin: persisted };
  }

  private async emitAppendEvent(
    msg: StoredMessage,
    operationId: string,
    revision: number,
    elements: readonly MessageElement[],
    baseRevision: number | undefined,
  ): Promise<number | undefined> {
    if (msg.visibility === 'whisper') return undefined;
    const emitted = await this.deps.events.append(
      msg.threadId,
      `append:${msg.id}:${operationId}`,
      {
        eventId: `ev_app_${msg.id}_${operationId}`,
        type: 'message.elements.append',
        messageId: msg.id,
        threadId: msg.threadId,
        operationId,
        ...(baseRevision !== undefined ? { baseRevision } : {}),
        revision,
        elements,
      },
      this.retentionCount,
    );
    return emitted.sequence;
  }

  /** Assemble a receipt only from persisted stamped elements and an emitted sequence. */
  private makeReceipt(
    msg: StoredMessage,
    parsed: AppendElementsInput,
    revision: number,
    elements: readonly MessageElement[],
    appendSequence: number | undefined,
  ): AppendReceipt {
    return {
      messageId: msg.id,
      revision,
      ...(appendSequence !== undefined ? { appendSequence } : {}),
      appliedElementIds: elements.map((el) => el.elementId),
    };
  }
}
