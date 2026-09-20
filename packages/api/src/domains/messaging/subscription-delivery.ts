/**
 * F202 Train C1 — Host-driven outbound to subscribing plugins.
 *
 * THE SHAPE. A subscriber declares which thread it wants and which of its own methods the Host
 * should call; when that thread produces a message the Host calls that method, and whatever the
 * subscriber does next is closed inside it.
 *
 * THIS MODULE HAS NO NOTION OF A PLUGIN. It knows only that N sinks implement an outbound method
 * and which of them are owed this thread's messages. A package relaying to an IM platform, a
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
 * than to a hole, and an accepted message is never sent twice (a duplicate outbound is a
 * duplicate message in someone's chat).
 */

import type { HostInvocationPort } from '../plugin/host-invocation.js';

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
  ): Promise<{ readonly events: readonly unknown[]; readonly ackToken: string | null; readonly stale: boolean }>;
  ack(ctx: DeliveryCallContext, subscriptionId: string, token: string): Promise<void>;
}

export interface SubscriptionDeliveryDeps {
  readonly messaging: SubscriptionDeliveryMessaging;
  /**
   * The Host→plugin direction, shared with every other reason the Host calls a package. Message
   * delivery is one consumer of it, not its owner.
   */
  readonly invocation: HostInvocationPort;
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
   * Skip messages this subscriber authored. A package that relays a thread outward is also
   * subscribed to it, so without this its own relayed message comes straight back and it relays
   * it again — one inbound "hi" becomes an endless conversation on a real platform. Subscribers
   * that want their own echo, like a live view confirming an optimistic update, simply omit it.
   */
  readonly excludeOwnMessages?: boolean;
}

/** What a subscriber declared: the thread it wants and the outbound method it implements. */
export interface SubscriptionDeclaration {
  readonly subscriberId: string;
  readonly threadId: string;
  readonly handleId: string;
  readonly method: string;
  readonly params?: Readonly<Record<string, unknown>>;
  readonly filter?: SubscriptionFilter;
}

interface Registration {
  readonly subscriberId: string;
  readonly subscriptionId: string;
  readonly method: string;
  readonly params?: Readonly<Record<string, unknown>>;
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

/** True when this subscriber wrote the event and asked not to be handed its own messages. */
function authoredBy(event: unknown, registration: Registration): boolean {
  if (registration.filter?.excludeOwnMessages !== true) return false;
  const actor = (event as { envelope?: { actor?: { kind?: unknown; id?: unknown } } })?.envelope?.actor;
  return actor?.kind === 'plugin' && actor.id === registration.subscriberId;
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
      method: declaration.method,
      ...(declaration.params === undefined ? {} : { params: declaration.params }),
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
        if (authoredBy(event, registration)) continue;
        await this.deps.invocation.invoke(registration.subscriberId, registration.method, {
          subscriptionId: registration.subscriptionId,
          event,
          ...(registration.params === undefined ? {} : { params: registration.params }),
        });
      }
      await this.deps.messaging.ack(ctx, registration.subscriptionId, result.ackToken);
    }
  }
}

export function createSubscriptionDelivery(deps: SubscriptionDeliveryDeps): SubscriptionDelivery {
  return new SubscriptionDelivery(deps);
}
