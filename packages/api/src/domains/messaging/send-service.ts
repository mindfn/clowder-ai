/**
 * Plugin Messaging — messaging.send orchestration (K-1 / F258, AC-1/AC-2)
 *
 * Order (D-3): validate → resolve handle → stamp provenance → derive audience
 * → ledger claim → persist → emit publish event → settle. Crash recovery:
 * persist uses a store-level idempotencyKey and emission uses a deterministic
 * eventKey, so a retry after a crash converges on the same message and emits
 * exactly once. Failure before settle releases the claim (retry re-executes).
 *
 * Whisper boundary (v0, F258 doc): whisper sends are NOT event-streamed —
 * fail-closed against leaking restricted content to subscribers.
 */

import type { CatId } from '@cat-cafe/shared';
import type { IMessageStore } from '../cats/services/stores/ports/MessageStore.js';
import type {
  CanonicalAudience,
  MessageDraft,
  MessageProvenance,
  PluginCallContext,
  SendReceipt,
} from './contract/types.js';
import { MessagingError } from './contract/types.js';
import { validateDraft } from './contract/validate.js';
import { projectEnvelope, renderElementsText } from './envelope.js';
import type { HandleService } from './handles.js';
import type { MessagingLedger } from './ledger.js';
import type { EventLogStore, HandleRecord } from './stores/ports.js';

export const EVENT_RETENTION_COUNT = 500;

export interface SendServiceDeps {
  readonly messageStore: IMessageStore;
  readonly handles: HandleService;
  readonly ledger: MessagingLedger;
  readonly events: EventLogStore;
  readonly retentionCount?: number;
}

/** D-4: validate the declared origin against handle-derived truth; return the stamped provenance. */
function stampProvenance(ctx: PluginCallContext, draft: MessageDraft, handle: HandleRecord): MessageProvenance {
  const declared = draft.payload.provenance.origin;
  if (handle.kind === 'thread_handle') {
    if (declared !== undefined) {
      if (declared.kind !== 'plugin' || declared.instanceId !== ctx.pluginInstanceId) {
        throw new MessagingError('PERMISSION', 'declared origin does not match the calling plugin instance (D-4)');
      }
    }
    return {
      origin: { kind: 'plugin', instanceId: ctx.pluginInstanceId },
      epistemicStatus: draft.payload.provenance.epistemicStatus,
    };
  }
  // connector_binding: external ingress — origin must be external and match the binding
  const binding = handle.connectorBinding;
  if (!binding) {
    throw new MessagingError('PERMISSION', 'connector binding handle has no binding record');
  }
  if (declared !== undefined) {
    if (declared.kind !== 'external' || declared.connectorId !== binding.connectorId) {
      throw new MessagingError('PERMISSION', 'declared origin does not match the connector binding (D-4)');
    }
    if (declared.sourceAddress !== undefined && declared.sourceAddress.chatId !== binding.externalChatId) {
      throw new MessagingError('PERMISSION', 'sourceAddress.chatId does not match the bound external chat (D-4)');
    }
  }
  return {
    origin: declared ?? { kind: 'external', connectorId: binding.connectorId },
    epistemicStatus: draft.payload.provenance.epistemicStatus,
  };
}

/** Derive canonical audience; whisper targets must sit inside the handle's grant set (§3.1). */
function deriveAudience(draft: MessageDraft, handle: HandleRecord): CanonicalAudience {
  const declared = draft.draftAudience;
  if (declared === undefined || declared.kind === 'public') return { kind: 'public' };
  const allowed = handle.scope.allowedWhisperTargets;
  if (!allowed || allowed.length === 0) {
    throw new MessagingError('PERMISSION', 'handle scope grants no whisper targets');
  }
  const allowedSet = new Set(allowed);
  const outside = declared.targets.filter((t) => !allowedSet.has(t));
  if (outside.length > 0) {
    throw new MessagingError('PERMISSION', 'whisper targets outside the granted set', { outside });
  }
  return { kind: 'whisper', targets: declared.targets };
}

export class SendService {
  private readonly deps: SendServiceDeps;
  private readonly retentionCount: number;

  constructor(deps: SendServiceDeps) {
    this.deps = deps;
    this.retentionCount = deps.retentionCount ?? EVENT_RETENTION_COUNT;
  }

  async send(ctx: PluginCallContext, input: unknown): Promise<SendReceipt> {
    const draft = validateDraft(input);
    const handle = await this.deps.handles.resolveForSend(ctx.pluginInstanceId, draft.address);
    const provenance = stampProvenance(ctx, draft, handle);
    const audience = deriveAudience(draft, handle);

    const claim = await this.deps.ledger.claimSend(ctx.pluginInstanceId, draft.idempotencyKey);
    if (claim.status === 'settled') return claim.receipt;
    if (claim.status === 'inflight') {
      throw new MessagingError('RETRYABLE_INFLIGHT', 'a send with this idempotencyKey is in flight — retry later');
    }

    try {
      const stored = await this.deps.messageStore.append({
        threadId: handle.threadId,
        userId: handle.userId,
        catId: null,
        content: renderElementsText(draft.payload.elements),
        mentions: [], // v0: plugin sends never trigger @-routing (wake power is K-3a scope)
        timestamp: Date.now(),
        ...(audience.kind === 'whisper'
          ? { visibility: 'whisper' as const, whisperTo: audience.targets as readonly CatId[] }
          : {}),
        ...(draft.replyTo !== undefined ? { replyTo: draft.replyTo } : {}),
        // Store-level idempotency (scoped userId:threadId:key) — D-3 crash recovery:
        // a re-executed send converges on the already-persisted message.
        idempotencyKey: `plugmsg:${ctx.pluginInstanceId}:${draft.idempotencyKey}`,
        extra: {
          pluginMessage: {
            instanceId: ctx.pluginInstanceId,
            revision: 1,
            provenance: provenance as unknown as Record<string, unknown>,
            elements: draft.payload.elements as unknown as ReadonlyArray<Record<string, unknown>>,
            appendOps: [],
          },
        },
      });

      let publishSequence: number | undefined;
      if (audience.kind !== 'whisper') {
        const envelope = projectEnvelope(stored);
        if (!envelope) {
          throw new MessagingError('VALIDATION', 'persisted message failed to project to an envelope');
        }
        const emitted = await this.deps.events.append(
          handle.threadId,
          `publish:${stored.id}:1`,
          { eventId: `ev_pub_${stored.id}_1`, type: 'message.publish', envelope },
          this.retentionCount,
        );
        publishSequence = emitted.sequence;
      }

      const receipt: SendReceipt = {
        messageId: stored.id,
        threadId: handle.threadId,
        revision: 1,
        ...(publishSequence !== undefined ? { publishSequence } : {}),
      };
      await this.deps.ledger.settleSend(ctx.pluginInstanceId, draft.idempotencyKey, receipt);
      return receipt;
    } catch (err) {
      await this.deps.ledger.releaseSend(ctx.pluginInstanceId, draft.idempotencyKey);
      throw err;
    }
  }
}
