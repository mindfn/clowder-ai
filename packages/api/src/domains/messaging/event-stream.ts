/**
 * Plugin Messaging — event stream subscriptions (K-1 / F288, AC-3, §4b)
 *
 * Cursor scope = (pluginInstanceId × subscription); ack cursors are durable.
 * Delivery = at-least-once for unacked events (INV-4); consumers dedupe by
 * eventId. The ack token is subscription-local and opaque (INV-5) — v0
 * opacity is contractual, enforcement is server-side subscription matching
 * plus the delivered watermark (the guard, not the token, is load-bearing;
 * cryptographic tokens are a F288 non-goal until K-2's untrusted transport).
 *
 * Stale (INV-9): cursor behind the retention floor → read returns
 * { stale: true } with zero events; snapshot() catches up from the message
 * store (pure projection) and resets the cursor to head. Acks of previously
 * delivered events stay valid across trims — they can cure staleness, never
 * cause silent skips (events ≤ acked sequence were delivered pre-trim).
 *
 * Subscribe idempotency: the (instance, handle) slot is won atomically via
 * CursorStore.createOrGet — concurrent subscribes converge on one
 * live cursor. After the claim the handle is re-checked so a revocation
 * cascade racing the subscribe cannot leave a live orphan (fail-closed with
 * HandleService.revoke's cascade-first ordering).
 *
 * v0 subscription binds ONE thread handle (D-2): cross-thread cursor misuse
 * is impossible by construction.
 */

import { randomUUID } from 'node:crypto';
import { type M0CSnapshotInput, type M0CSnapshotResult, validateMessagingRowInput } from '@clowder-ai/plugin-contract';
import type { IMessageStore, StoredMessage } from '../cats/services/stores/ports/MessageStore.js';
import { isInternalNonQuotableParent } from '../cats/services/stores/visibility.js';
import type { PluginCallContext, ReadResult, SnapshotResult, SubscribeResult } from './contract/host-types.js';
import { MessagingError } from './contract/host-types.js';
import { projectEnvelope, readPluginMessageExtra } from './envelope.js';
import type { HandleService } from './handles.js';
import { decodeSnapshotPageToken, encodeSnapshotAckToken, encodeSnapshotPageToken } from './snapshot-tokens.js';
import type { CursorStore, EventLogStore, SnapshotViewRecord, SubscriptionRecord } from './stores/ports.js';

export const DEFAULT_READ_LIMIT = 32;
export const MAX_READ_LIMIT = 32;
export const SNAPSHOT_MAX_ATTEMPTS = 3;

export interface EventStreamDeps {
  readonly events: EventLogStore;
  readonly cursors: CursorStore;
  readonly handles: HandleService;
  readonly messageStore: IMessageStore;
}

interface AckTokenPayload {
  readonly s: string;
  readonly q: number;
  readonly n: string;
  readonly k?: 'snapshot';
}

function encodeAckToken(subscriptionId: string, sequence: number): string {
  const payload: AckTokenPayload = { s: subscriptionId, q: sequence, n: randomUUID().slice(0, 8) };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeAckToken(token: string): AckTokenPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  } catch {
    throw new MessagingError('VALIDATION', 'malformed ack token');
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as Record<string, unknown>).s !== 'string' ||
    typeof (parsed as Record<string, unknown>).n !== 'string' ||
    typeof (parsed as Record<string, unknown>).q !== 'number' ||
    !Number.isInteger((parsed as Record<string, unknown>).q) ||
    ((parsed as Record<string, unknown>).k !== undefined && (parsed as Record<string, unknown>).k !== 'snapshot')
  ) {
    throw new MessagingError('VALIDATION', 'malformed ack token');
  }
  return parsed as unknown as AckTokenPayload;
}

/**
 * Snapshot visibility (fail-closed, secondary filter after the plugin-owned
 * check): whisper, system/briefing plumbing, scheduler hidden triggers, and
 * A2A routing markers are host-internal — projecting them would fabricate
 * user_intent provenance for host machinery (C-1 provenance mapping).
 *
 * The primary domain boundary is enforced in snapshot() itself: only messages
 * with extra.pluginMessage (mutations tracked by the plugin event log) are
 * included. This filter handles the remaining visibility exclusions within
 * the plugin-owned set.
 */
function isSnapshotVisible(msg: {
  visibility?: string;
  userId: string;
  origin?: string;
  extra?: { systemKind?: string; scheduler?: { hiddenTrigger?: boolean } };
}): boolean {
  if (msg.visibility === 'whisper') return false;
  if (isInternalNonQuotableParent(msg as Parameters<typeof isInternalNonQuotableParent>[0])) return false;
  if (msg.extra?.systemKind !== undefined) return false;
  if (msg.extra?.scheduler?.hiddenTrigger) return false;
  if (msg.userId === 'scheduler') return false;
  return true;
}

function isSnapshotCandidate(msg: StoredMessage): boolean {
  if (msg.extra?.pluginMessage === undefined) return false;
  if (msg.deletedAt !== undefined || msg._tombstone) return false;
  return isSnapshotVisible(msg);
}

function projectSnapshotAtHead(
  messages: readonly StoredMessage[],
  headSequence: number,
): SnapshotResult['envelopes'] | null {
  const envelopes: SnapshotResult['envelopes'][number][] = [];
  for (const msg of messages) {
    if (!isSnapshotCandidate(msg)) continue;
    const plugin = readPluginMessageExtra(msg);
    if (
      !plugin ||
      plugin.outputRevision !== plugin.revision ||
      plugin.outputSequence === undefined ||
      plugin.outputSequence > headSequence
    ) {
      return null;
    }
    const envelope = projectEnvelope(msg);
    if (envelope) envelopes.push(envelope);
  }
  return envelopes;
}

export class EventStreamService {
  private readonly deps: EventStreamDeps;

  constructor(deps: EventStreamDeps) {
    this.deps = deps;
  }

  async subscribe(ctx: PluginCallContext, handleId: string): Promise<SubscribeResult> {
    const handle = await this.deps.handles.resolveForSubscribe(ctx.pluginInstanceId, handleId);
    const existing = await this.deps.cursors.findByHandle(ctx.pluginInstanceId, handleId);
    if (existing) return { subscriptionId: existing.subscriptionId };

    const head = await this.deps.events.headSequence(handle.threadId);
    const record: SubscriptionRecord = {
      subscriptionId: `sub_${randomUUID()}`,
      pluginInstanceId: ctx.pluginInstanceId,
      handleId,
      threadId: handle.threadId,
      ackedSequence: head,
      lastDeliveredSequence: head,
    };
    const winner = await this.deps.cursors.createOrGet(record);

    // Close the subscribe-vs-revocation race: if the handle was revoked while
    // we were writing, revoke what we just created instead of leaking a live
    // subscription on a dead handle.
    try {
      await this.deps.handles.resolveForSubscribe(ctx.pluginInstanceId, handleId);
    } catch (err) {
      await this.deps.cursors.revokeByHandle(handleId, Date.now());
      throw err;
    }

    return { subscriptionId: winner.subscriptionId };
  }

  /** Common gate: existence (instance-scoped lookup) → liveness. */
  private async requireLiveSubscription(ctx: PluginCallContext, subscriptionId: string): Promise<SubscriptionRecord> {
    const sub = await this.deps.cursors.get(ctx.pluginInstanceId, subscriptionId);
    if (!sub) throw new MessagingError('NOT_FOUND', `unknown subscription ${subscriptionId}`);
    if (sub.revokedAt !== undefined) {
      throw new MessagingError('PERMISSION', 'subscription revoked (handle revocation cascade)');
    }
    // The cascade is an optimization, not the authority. Re-checking the
    // handle closes crash/race windows between HandleStore.revoke and cursor
    // fan-out, so a dead handle can never retain a readable subscription.
    await this.deps.handles.resolveForSubscribe(ctx.pluginInstanceId, sub.handleId);
    return sub;
  }

  async read(ctx: PluginCallContext, subscriptionId: string, options: { limit?: number }): Promise<ReadResult> {
    if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1)) {
      throw new MessagingError('VALIDATION', 'limit must be a positive integer when present');
    }
    const sub = await this.requireLiveSubscription(ctx, subscriptionId);
    const limit = Math.min(options.limit ?? DEFAULT_READ_LIMIT, MAX_READ_LIMIT);
    // Read first, then inspect the retention floor. If a concurrent append
    // trims between the two calls, the newer floor makes us return stale. The
    // inverse order can observe an old floor followed by a trimmed page and
    // silently skip the removed events.
    const events = await this.deps.events.readAfter(sub.threadId, sub.ackedSequence, limit);
    const floor = await this.deps.events.minSequence(sub.threadId);
    if (floor !== null && sub.ackedSequence < floor - 1) {
      return { events: [], ackToken: null, stale: true }; // INV-9: surface, never skip
    }
    if (events.length === 0) return { events: [], ackToken: null, stale: false };
    const last = events[events.length - 1];
    const lastSequence = last ? last.sequence : sub.ackedSequence;
    await this.deps.cursors.advanceDelivered(ctx.pluginInstanceId, subscriptionId, lastSequence);
    return { events, ackToken: encodeAckToken(subscriptionId, lastSequence), stale: false };
  }

  async ack(ctx: PluginCallContext, subscriptionId: string, token: string): Promise<void> {
    const sub = await this.requireLiveSubscription(ctx, subscriptionId);
    const payload = decodeAckToken(token);
    if (payload.s !== subscriptionId) {
      throw new MessagingError('PERMISSION', 'ack token belongs to a different subscription (INV-5)');
    }
    if (payload.k === 'snapshot') {
      const outcome = await this.deps.cursors.ackSnapshot(ctx.pluginInstanceId, subscriptionId, payload.n, payload.q);
      if (outcome === 'rejected') {
        throw new MessagingError('PERMISSION', 'snapshot ack token is not an active entitlement');
      }
      return;
    }
    if (payload.q > sub.lastDeliveredSequence) {
      throw new MessagingError('PERMISSION', 'ack token sequence exceeds delivered watermark');
    }
    await this.deps.cursors.advanceAck(ctx.pluginInstanceId, subscriptionId, payload.q);
  }

  /**
   * Catch-up path (INV-9): project the recent public message window to
   * envelopes and reset the cursor to the current head. Window size documents
   * the same retention philosophy as the event log.
   */
  async snapshot(ctx: PluginCallContext, subscriptionId: string): Promise<SnapshotResult> {
    const sub = await this.requireLiveSubscription(ctx, subscriptionId);
    const captured = await this.captureSnapshot(sub);
    await this.deps.cursors.advanceDelivered(ctx.pluginInstanceId, subscriptionId, captured.headSequence);
    await this.deps.cursors.advanceAck(ctx.pluginInstanceId, subscriptionId, captured.headSequence);
    return { envelopes: captured.items, resumeSequence: captured.headSequence };
  }

  async snapshotPage(ctx: PluginCallContext, input: M0CSnapshotInput): Promise<M0CSnapshotResult> {
    const validation = validateMessagingRowInput('messaging.snapshot', input);
    if (!validation.valid) throw new MessagingError('VALIDATION', 'invalid snapshot page request');
    const parsed = validation.value;
    const sub = await this.requireLiveSubscription(ctx, parsed.subscriptionId);
    const { snapshot, offset, pageTokenId } = await this.resolveSnapshotView(ctx, parsed, sub);

    if (offset > snapshot.items.length) {
      throw new MessagingError('VALIDATION', 'snapshot page token offset is outside the frozen view');
    }
    const items = structuredClone(snapshot.items.slice(offset, offset + parsed.maxItems));
    const nextOffset = offset + items.length;
    const traversalComplete = nextOffset >= snapshot.items.length;
    const nextPageTokenId = traversalComplete ? undefined : randomUUID();
    const consumed = await this.deps.cursors.consumeSnapshotPage(
      ctx.pluginInstanceId,
      parsed.subscriptionId,
      snapshot.snapshotId,
      { offset, ...(pageTokenId === undefined ? {} : { tokenId: pageTokenId }) },
      {
        offset: nextOffset,
        ...(nextPageTokenId === undefined ? {} : { tokenId: nextPageTokenId }),
        traversalComplete,
      },
    );
    if (!consumed) throw new MessagingError('PERMISSION', 'snapshot page token is not an active entitlement');
    if (!traversalComplete && nextPageTokenId !== undefined) {
      return {
        items,
        nextPageToken: encodeSnapshotPageToken(parsed.subscriptionId, snapshot.snapshotId, nextOffset, nextPageTokenId),
        snapshotAckToken: null,
      };
    }
    return {
      items,
      nextPageToken: null,
      snapshotAckToken: encodeSnapshotAckToken(parsed.subscriptionId, snapshot),
    };
  }

  private async resolveSnapshotView(
    ctx: PluginCallContext,
    input: M0CSnapshotInput,
    sub: SubscriptionRecord,
  ): Promise<{ snapshot: SnapshotViewRecord; offset: number; pageTokenId?: string }> {
    if (input.pageToken !== undefined) {
      const token = decodeSnapshotPageToken(input.pageToken);
      if (token.s !== input.subscriptionId) {
        throw new MessagingError('PERMISSION', 'snapshot page token belongs to a different subscription');
      }
      if (!sub.snapshotView || sub.snapshotView.snapshotId !== token.v) {
        throw new MessagingError('STALE_CURSOR', 'snapshot view is no longer active');
      }
      return { snapshot: sub.snapshotView, offset: token.o, pageTokenId: token.n };
    }
    if (sub.snapshotView) return { snapshot: sub.snapshotView, offset: 0 };

    const captured = await this.captureSnapshot(sub);
    const snapshot = await this.deps.cursors.createOrGetSnapshot(ctx.pluginInstanceId, input.subscriptionId, {
      snapshotId: `snap_${randomUUID()}`,
      headSequence: captured.headSequence,
      items: captured.items,
      createdAt: Date.now(),
      nextOffset: 0,
      traversalComplete: false,
    });
    if (!snapshot) throw new MessagingError('PERMISSION', 'subscription revoked during snapshot capture');
    return { snapshot, offset: 0 };
  }

  private async captureSnapshot(
    sub: SubscriptionRecord,
  ): Promise<{ items: SnapshotResult['envelopes']; headSequence: number }> {
    for (let attempt = 0; attempt < SNAPSHOT_MAX_ATTEMPTS; attempt += 1) {
      const headBefore = await this.deps.events.headSequence(sub.threadId);
      const messages = await this.deps.messageStore.getByThreadAfter(sub.threadId);
      const headAfter = await this.deps.events.headSequence(sub.threadId);
      if (headBefore !== headAfter) continue;
      // K-1 domain boundary: only plugin-owned messages whose mutations are
      // fenced by the plugin event head belong in this frozen projection.
      const envelopes = projectSnapshotAtHead(messages, headBefore);
      if (!envelopes) continue;
      return { items: envelopes, headSequence: headBefore };
    }
    throw new MessagingError('RETRYABLE_INFLIGHT', 'snapshot raced an output mutation — retry later');
  }
}
