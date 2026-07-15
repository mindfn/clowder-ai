/**
 * Plugin Messaging — messaging.appendElements (K-1 / F258, AC-4, §4d)
 *
 * Atomicity: per-message lock serializes appends; the read-check-write on
 * extra.pluginMessage happens entirely inside the lock. baseRevision gives
 * callers optimistic concurrency on top (INV-10). Idempotency: ledger key
 * (instance, messageId, operationId) + appendOps replay guard INSIDE the lock
 * covers the crash window between write and settle (INV-12).
 *
 * Provenance (INV-7): appended elements are stamped 'inference' unless they
 * explicitly claim a status equal to their derivation source's status —
 * appends can never elevate epistemic standing, and omission never inherits
 * the message-level status silently.
 *
 * Applied-revision reconstruction on replay: send fixes revision 1 and each
 * append bumps by exactly 1, so the op at appendOps index i produced
 * revision i+2 — derivable, no extra state (派生值规则).
 */

import type { IMessageStore, StoredMessage } from '../cats/services/stores/ports/MessageStore.js';
import type {
  AppendElementsInput,
  AppendReceipt,
  EpistemicStatus,
  MessageElement,
  PluginCallContext,
} from './contract/types.js';
import { MessagingError } from './contract/types.js';
import { validateAppendInput } from './contract/validate.js';
import { type PluginMessageExtra, readPluginMessageExtra } from './envelope.js';
import type { MessagingLedger } from './ledger.js';
import type { AppendLock, EventLogStore } from './stores/ports.js';

export const APPEND_LOCK_TTL_MS = 5_000;
const EVENT_RETENTION_COUNT = 500;

export interface AppendServiceDeps {
  readonly messageStore: IMessageStore;
  readonly ledger: MessagingLedger;
  readonly events: EventLogStore;
  readonly appendLock: AppendLock;
  readonly retentionCount?: number;
}

function statusOf(element: MessageElement, plugin: PluginMessageExtra): EpistemicStatus {
  return element.epistemicStatus ?? plugin.provenance.epistemicStatus;
}

/** INV-7: stamp appended elements; reject elevation and underivated non-inference claims. */
function stampAppendedElements(
  parsed: AppendElementsInput,
  plugin: PluginMessageExtra,
  existingIds: ReadonlySet<string>,
): MessageElement[] {
  const stamped: MessageElement[] = [];
  for (const element of parsed.elements) {
    if (existingIds.has(element.elementId)) {
      throw new MessagingError('VALIDATION', `elementId "${element.elementId}" already exists (INV-6: no rewrite)`);
    }
    let source: MessageElement | undefined;
    if (element.derivedFromElementId !== undefined) {
      source = plugin.elements.find((el) => el.elementId === element.derivedFromElementId);
      if (!source) {
        throw new MessagingError(
          'VALIDATION',
          `derivedFromElementId "${element.derivedFromElementId}" does not reference a persisted element`,
        );
      }
    }
    const claimed = element.epistemicStatus ?? 'inference';
    if (claimed !== 'inference') {
      if (!source || statusOf(source, plugin) !== claimed) {
        throw new MessagingError(
          'PERMISSION',
          'appended element claims a non-inference status without an equal-status derivation source (INV-7)',
        );
      }
    }
    stamped.push({ ...element, epistemicStatus: claimed });
  }
  return stamped;
}

export class AppendService {
  private readonly deps: AppendServiceDeps;
  private readonly retentionCount: number;

  constructor(deps: AppendServiceDeps) {
    this.deps = deps;
    this.retentionCount = deps.retentionCount ?? EVENT_RETENTION_COUNT;
  }

  async appendElements(ctx: PluginCallContext, input: unknown): Promise<AppendReceipt> {
    const parsed = validateAppendInput(input);
    const claim = await this.deps.ledger.claimAppend(ctx.pluginInstanceId, parsed.messageId, parsed.operationId);
    if (claim.status === 'settled') return claim.receipt;
    if (claim.status === 'inflight') {
      throw new MessagingError('RETRYABLE_INFLIGHT', 'an append with this operationId is in flight — retry later');
    }

    try {
      const acquired = await this.deps.appendLock.acquire(parsed.messageId, APPEND_LOCK_TTL_MS);
      if (!acquired) {
        throw new MessagingError('RETRYABLE_INFLIGHT', 'message is being appended by another operation — retry later');
      }
      try {
        const receipt = await this.applyLocked(ctx, parsed);
        await this.deps.ledger.settleAppend(ctx.pluginInstanceId, parsed.messageId, parsed.operationId, receipt);
        return receipt;
      } finally {
        await this.deps.appendLock.release(parsed.messageId);
      }
    } catch (err) {
      await this.deps.ledger.releaseAppend(ctx.pluginInstanceId, parsed.messageId, parsed.operationId);
      throw err;
    }
  }

  /** Runs inside the per-message lock. */
  private async applyLocked(ctx: PluginCallContext, parsed: AppendElementsInput): Promise<AppendReceipt> {
    const msg = await this.deps.messageStore.getById(parsed.messageId);
    if (!msg || msg.deletedAt !== undefined || msg._tombstone) {
      throw new MessagingError('NOT_FOUND', `message ${parsed.messageId} not found`);
    }
    const plugin = readPluginMessageExtra(msg);
    if (!plugin) {
      throw new MessagingError('PERMISSION', 'appendElements targets a non-plugin message');
    }
    if (plugin.instanceId !== ctx.pluginInstanceId) {
      throw new MessagingError('PERMISSION', 'message belongs to a different plugin instance (INV-8)');
    }

    // INV-12 replay guard inside the lock: write landed, settle crashed.
    const replayIndex = plugin.appendOps.indexOf(parsed.operationId);
    if (replayIndex >= 0) {
      return this.buildReceipt(
        msg,
        parsed,
        replayIndex + 2,
        parsed.elements.map((el) => el.elementId),
      );
    }

    if (parsed.baseRevision !== undefined && parsed.baseRevision !== plugin.revision) {
      throw new MessagingError('CONFLICT', 'baseRevision does not match the current revision (INV-10)', {
        baseRevision: parsed.baseRevision,
        currentRevision: plugin.revision,
      });
    }

    const existingIds = new Set(plugin.elements.map((el) => el.elementId));
    const stamped = stampAppendedElements(parsed, plugin, existingIds);
    const newRevision = plugin.revision + 1;
    const updated: PluginMessageExtra = {
      ...plugin,
      revision: newRevision,
      elements: [...plugin.elements, ...stamped],
      appendOps: [...plugin.appendOps, parsed.operationId],
    };
    const nextExtra = {
      ...(msg.extra ?? {}),
      pluginMessage: updated as unknown as NonNullable<StoredMessage['extra']>['pluginMessage'],
    };
    const written = await this.deps.messageStore.updateExtra(msg.id, nextExtra);
    if (!written) {
      throw new MessagingError('NOT_FOUND', `message ${parsed.messageId} disappeared during append`);
    }

    return this.buildReceipt(
      written,
      parsed,
      newRevision,
      stamped.map((el) => el.elementId),
      stamped,
    );
  }

  /** Emit (whisper-gated, eventKey-deduped) and assemble the receipt. */
  private async buildReceipt(
    msg: StoredMessage,
    parsed: AppendElementsInput,
    revision: number,
    appliedElementIds: readonly string[],
    stamped?: readonly MessageElement[],
  ): Promise<AppendReceipt> {
    let appendSequence: number | undefined;
    if (msg.visibility !== 'whisper') {
      const elements =
        stamped ?? parsed.elements.map((el) => ({ ...el, epistemicStatus: el.epistemicStatus ?? 'inference' }));
      const emitted = await this.deps.events.append(
        msg.threadId,
        `append:${msg.id}:${parsed.operationId}`,
        {
          eventId: `ev_app_${msg.id}_${parsed.operationId}`,
          type: 'message.elements.append',
          messageId: msg.id,
          threadId: msg.threadId,
          operationId: parsed.operationId,
          ...(parsed.baseRevision !== undefined ? { baseRevision: parsed.baseRevision } : {}),
          revision,
          elements,
        },
        this.retentionCount,
      );
      appendSequence = emitted.sequence;
    }
    return {
      messageId: msg.id,
      revision,
      ...(appendSequence !== undefined ? { appendSequence } : {}),
      appliedElementIds: [...appliedElementIds],
    };
  }
}
