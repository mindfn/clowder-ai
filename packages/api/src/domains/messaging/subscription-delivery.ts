/**
 * F202 Train C1 — Host-driven outbound to subscribing plugins.
 *
 * THE SHAPE. A subscriber declares which thread it wants; when that thread publishes a complete
 * message envelope the Host sends the frozen `host.messaging.deliver` row to its runtime.
 *
 * THIS MODULE HAS NO NOTION OF A PLUGIN. It knows only that N sinks implement the standard
 * delivery row and which of them are owed this thread's messages. A package relaying to an IM platform, a
 * front-desk subscriber, and — once the UI's 112 scattered `broadcastToRoom` call sites are
 * converged onto it — the live view itself are all the same kind of thing here, differing only
 * in the sink that carries the call.
 *
 * WHY THE LOOP IS HERE AND NOT IN EVERY PLUGIN. The durable half already exists and is already
 * published: `subscribe`/`read`/`ack` carry the cursor, the replay floor and the INV-9 stale
 * signal. This driver is a Host-side consumer of the Host's own published API, so there is one
 * consume loop with one set of failure semantics instead of one per plugin author. The only
 * surface this adds is the direction itself — calling a plugin.
 *
 * DELIVERY GUARANTEE. The cursor advances only on an accepted call: a page is acked after every
 * event in it was accepted, so a plugin that was briefly down comes back to its messages rather
 * than to a hole. Retries keep the same Host-issued deliveryId, including a crash between remote
 * acceptance and cursor ack, so the receiving adapter can settle the call idempotently instead
 * of producing a duplicate message in someone's chat.
 */

import { createHash } from 'node:crypto';

import type { MessageOutputEvent } from '@clowder-ai/plugin-contract';
import type { HostMessagingDeliveryPort } from '../plugin/host-invocation.js';

/**
 * The messaging domain identifies a subscriber by `pluginInstanceId`; that field is its name for
 * whoever holds the handle, not a claim that the subscriber is a package.
 */
interface DeliveryCallContext {
  readonly pluginInstanceId: string;
}

export interface SubscriptionDeliveryMessaging {
  subscribe(ctx: DeliveryCallContext, handleId: string): Promise<{ subscriptionId: string }>;
  read(
    ctx: DeliveryCallContext,
    subscriptionId: string,
    options: { limit?: number },
  ): Promise<{
    readonly events: readonly MessageOutputEvent[];
    readonly ackToken: string | null;
    readonly stale: boolean;
  }>;
  ack(ctx: DeliveryCallContext, subscriptionId: string, token: string): Promise<void>;
}

export interface SubscriptionDeliveryDeps {
  readonly messaging: SubscriptionDeliveryMessaging;
  /** The already-published `host.messaging.deliver` direction. */
  readonly delivery: HostMessagingDeliveryPort;
  /** Events per read page. */
  readonly readLimit?: number;
  /**
   * Pages drained per call before yielding. A backlog is not lost — the cursor holds it and the
   * next drain continues — but one thread cannot monopolise the Host either.
   */
  readonly maxPagesPerDrain?: number;
}

/**
 * What a subscriber declares about which of the thread's messages it wants. Declared by the
 * subscriber rather than decided by the Host, but applied by the Host — a subscriber filtering
 * itself would already have received what it wanted excluded.
 */
export interface SubscriptionFilter {
  /**
   * Opt in to being handed back the messages this subscriber itself authored. Off by default,
   * and the default is the whole point.
   *
   * A package that relays a thread outward is also subscribed to it, so if its own relayed
   * message comes back it relays that onward too — one inbound "hi" becoming an endless
   * conversation on somebody's real platform. Making echo opt-out would have put that outcome
   * one forgotten line away in every relaying package, and `filter` is an untyped pocket
   * (`additionalProperties: true`, absent from `required`), so a misspelled key, a string
   * `"true"`, or no filter at all would all have validated and then looped.
   *
   * Inverted, every one of those mistakes degrades to silence instead of a flood, and no
   * package has to remember anything to be safe. A subscriber that genuinely wants its own
   * echo — a live view confirming an optimistic update — asks for it deliberately.
   */
  readonly includeOwnMessages?: boolean;
}

/** What a subscriber declared: the thread it wants and the outbound method it implements. */
export interface SubscriptionDeclaration {
  readonly subscriberId: string;
  readonly threadId: string;
  readonly handleId: string;
  readonly filter?: SubscriptionFilter;
}

interface Registration {
  readonly subscriberId: string;
  readonly subscriptionId: string;
  readonly handleId: string;
  readonly filter?: SubscriptionFilter;
}

/** Raised when the log was trimmed past a subscriber's cursor (INV-9: surface, never skip). */
export class SubscriptionDeliveryStaleError extends Error {
  readonly subscriptionId: string;
  constructor(subscriptionId: string) {
    super(`subscription ${subscriptionId} fell behind the retained window — replay required`);
    this.name = 'SubscriptionDeliveryStaleError';
    this.subscriptionId = subscriptionId;
  }
}

const DEFAULT_MAX_PAGES = 32;

/**
 * True when this subscriber authored the event and has not asked for its own echo. Only an
 * explicit `true` opts in, so a pocket key that is misspelled or carries a string falls through
 * to suppression — the safe side.
 */
function isUnwantedEcho(event: MessageOutputEvent, registration: Registration): boolean {
  if (registration.filter?.includeOwnMessages === true) return false;
  const actor = event.type === 'message.publish' ? event.envelope.actor : undefined;
  return actor?.kind === 'plugin' && actor.id === registration.subscriberId;
}

function deliveryIdFor(registration: Registration, event: MessageOutputEvent): string {
  const digest = createHash('sha256')
    .update(registration.subscriberId)
    .update('\0')
    .update(registration.subscriptionId)
    .update('\0')
    .update(event.eventId)
    .digest('hex');
  return `delivery_${digest}`;
}

async function deliverPublishedEvent(
  delivery: HostMessagingDeliveryPort,
  registration: Registration,
  event: MessageOutputEvent,
): Promise<void> {
  if (isUnwantedEcho(event, registration)) return;
  // The frozen callback row carries a complete envelope. Append events remain available
  // through explicit stream reads and must not be disguised as a different wire shape.
  if (event.type !== 'message.publish') return;

  const input = {
    deliveryId: deliveryIdFor(registration, event),
    threadHandle: { kind: 'thread_handle' as const, handle: registration.handleId },
    envelope: event.envelope,
  };
  const receipt = await delivery.deliver(registration.subscriberId, input);
  if (receipt.deliveryId !== input.deliveryId) {
    throw new Error(`delivery receipt mismatch for ${input.deliveryId}`);
  }
}

export class SubscriptionDelivery {
  private readonly deps: SubscriptionDeliveryDeps;
  private readonly byThread = new Map<string, Registration[]>();

  constructor(deps: SubscriptionDeliveryDeps) {
    this.deps = deps;
  }

  /** Idempotent: re-declaring the same handle reuses its subscription rather than doubling it. */
  async register(declaration: SubscriptionDeclaration): Promise<void> {
    const ctx = { pluginInstanceId: declaration.subscriberId };
    const { subscriptionId } = await this.deps.messaging.subscribe(ctx, declaration.handleId);

    const existing = this.byThread.get(declaration.threadId) ?? [];
    if (existing.some((entry) => entry.subscriptionId === subscriptionId)) return;
    existing.push({
      subscriberId: declaration.subscriberId,
      subscriptionId,
      handleId: declaration.handleId,
      ...(declaration.filter === undefined ? {} : { filter: declaration.filter }),
    });
    this.byThread.set(declaration.threadId, existing);
  }

  /**
   * Deliver everything outstanding on this thread. Subscribers are independent: one sink being
   * down must not starve the others, so each is attempted and the first failure is surfaced only
   * after all of them have had their turn.
   */
  async drain(threadId: string): Promise<void> {
    const registrations = this.byThread.get(threadId) ?? [];
    let failure: unknown;
    for (const registration of registrations) {
      try {
        await this.drainOne(registration);
      } catch (err) {
        if (failure === undefined) failure = err;
      }
    }
    if (failure !== undefined) throw failure;
  }

  private async drainOne(registration: Registration): Promise<void> {
    const ctx = { pluginInstanceId: registration.subscriberId };
    const maxPages = this.deps.maxPagesPerDrain ?? DEFAULT_MAX_PAGES;

    for (let page = 0; page < maxPages; page += 1) {
      const result = await this.deps.messaging.read(ctx, registration.subscriptionId, {
        ...(this.deps.readLimit === undefined ? {} : { limit: this.deps.readLimit }),
      });
      if (result.stale) throw new SubscriptionDeliveryStaleError(registration.subscriptionId);
      if (result.events.length === 0 || result.ackToken === null) return;

      // Ack covers the whole page, so every event in it must be accepted first. A throw here
      // leaves the cursor where it was and the page returns on the next drain. A filtered-out
      // event is still covered by that ack: skipping is a decision about this subscriber, not a
      // failure, and leaving it unacked would replay it forever.
      for (const event of result.events) {
        await deliverPublishedEvent(this.deps.delivery, registration, event);
      }
      await this.deps.messaging.ack(ctx, registration.subscriptionId, result.ackToken);
    }
  }
}

export function createSubscriptionDelivery(deps: SubscriptionDeliveryDeps): SubscriptionDelivery {
  return new SubscriptionDelivery(deps);
}
