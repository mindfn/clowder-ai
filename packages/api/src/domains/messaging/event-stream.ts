/**
 * Plugin Messaging — event stream subscriptions (K-1 / F258, AC-3, §4b)
 *
 * Cursor scope = (pluginInstanceId × subscription); ack cursors are durable.
 * Delivery = at-least-once for unacked events (INV-4); consumers dedupe by
 * eventId. The ack token is subscription-local and opaque (INV-5) — v0
 * opacity is contractual, enforcement is server-side subscription matching,
 * not cryptography (F258 non-goal).
 *
 * Stale (INV-9): cursor behind the retention floor → read returns
 * { stale: true } with zero events; snapshot() catches up from the message
 * store (pure projection) and resets the cursor to head. Acks of previously
 * delivered events stay valid across trims — they can cure staleness, never
 * cause silent skips (events ≤ acked sequence were delivered pre-trim).
 *
 * v0 subscription binds ONE thread handle (D-2): cross-thread cursor misuse
 * is impossible by construction.
 */

import { randomUUID } from 'node:crypto';
import type { IMessageStore } from '../cats/services/stores/ports/MessageStore.js';
import type { PluginCallContext, ReadResult, SnapshotResult, SubscribeResult } from './contract/types.js';
import { MessagingError } from './contract/types.js';
import { projectEnvelope } from './envelope.js';
import type { HandleService } from './handles.js';
import type { CursorStore, EventLogStore, SubscriptionRecord } from './stores/ports.js';

export const DEFAULT_READ_LIMIT = 100;
export const MAX_READ_LIMIT = 500;
export const SNAPSHOT_MESSAGE_LIMIT = 200;

export interface EventStreamDeps {
  readonly events: EventLogStore;
  readonly cursors: CursorStore;
  readonly handles: HandleService;
  readonly messageStore: IMessageStore;
  readonly retentionCount?: number;
}

interface AckTokenPayload {
  readonly s: string;
  readonly q: number;
  readonly n: string;
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
    typeof (parsed as Record<string, unknown>).q !== 'number' ||
    !Number.isInteger((parsed as Record<string, unknown>).q)
  ) {
    throw new MessagingError('VALIDATION', 'malformed ack token');
  }
  return parsed as unknown as AckTokenPayload;
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
    await this.deps.cursors.put(record);
    return { subscriptionId: record.subscriptionId };
  }

  /** Common gate: existence (instance-scoped lookup) → liveness. */
  private async requireLiveSubscription(ctx: PluginCallContext, subscriptionId: string): Promise<SubscriptionRecord> {
    const sub = await this.deps.cursors.get(ctx.pluginInstanceId, subscriptionId);
    if (!sub) throw new MessagingError('NOT_FOUND', `unknown subscription ${subscriptionId}`);
    if (sub.revokedAt !== undefined) {
      throw new MessagingError('PERMISSION', 'subscription revoked (handle revocation cascade)');
    }
    return sub;
  }

  async read(ctx: PluginCallContext, subscriptionId: string, options: { limit?: number }): Promise<ReadResult> {
    const sub = await this.requireLiveSubscription(ctx, subscriptionId);
    const floor = await this.deps.events.minSequence(sub.threadId);
    if (floor !== null && sub.ackedSequence < floor - 1) {
      return { events: [], ackToken: null, stale: true }; // INV-9: surface, never skip
    }
    const limit = Math.max(1, Math.min(options.limit ?? DEFAULT_READ_LIMIT, MAX_READ_LIMIT));
    const events = await this.deps.events.readAfter(sub.threadId, sub.ackedSequence, limit);
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
    if (payload.q > sub.lastDeliveredSequence) {
      throw new MessagingError('PERMISSION', 'ack token sequence exceeds delivered watermark');
    }
    await this.deps.cursors.advanceAck(ctx.pluginInstanceId, subscriptionId, payload.q);
  }

  /**
   * Catch-up path (INV-9): project the recent message window to envelopes and
   * reset the cursor to the current head. Whisper/deleted messages never leave
   * the host (fail-closed visibility); window size documents the same
   * retention philosophy as the event log.
   */
  async snapshot(ctx: PluginCallContext, subscriptionId: string): Promise<SnapshotResult> {
    const sub = await this.requireLiveSubscription(ctx, subscriptionId);
    const head = await this.deps.events.headSequence(sub.threadId);
    const messages = await this.deps.messageStore.getByThread(sub.threadId, SNAPSHOT_MESSAGE_LIMIT);
    const envelopes = [];
    for (const msg of messages) {
      if (msg.visibility === 'whisper') continue;
      const envelope = projectEnvelope(msg);
      if (envelope) envelopes.push(envelope);
    }
    await this.deps.cursors.advanceDelivered(ctx.pluginInstanceId, subscriptionId, head);
    await this.deps.cursors.advanceAck(ctx.pluginInstanceId, subscriptionId, head);
    return { envelopes, resumeSequence: head };
  }
}
