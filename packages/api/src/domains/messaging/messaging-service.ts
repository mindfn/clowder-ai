/**
 * Plugin Messaging — domain facade (K-1 / F288)
 *
 * The single consumption surface for the K-2 Host Broker: handle issuance
 * (control plane takes over the entry point in K-2), messaging.send,
 * messaging.appendElements, and the cursor-based output event subscription.
 * Composes the domain services over one MessagingStores set.
 */

import type { RedisClient } from '@cat-cafe/shared/utils';
import type { AppendReceipt, M0CSnapshotInput, M0CSnapshotResult, SendReceipt } from '@clowder-ai/plugin-contract';
import type { IMessageStore } from '../cats/services/stores/ports/MessageStore.js';
import { AppendService } from './append-service.js';
import type { PluginCallContext, ReadResult, SnapshotResult, SubscribeResult } from './contract/host-types.js';
import { EventStreamService } from './event-stream.js';
import { HandleService, type IssueConnectorBindingHandleInput, type IssueThreadHandleInput } from './handles.js';
import type { MessagingIngressWakeDeps } from './ingress-wake.js';
import { MessagingLedger } from './ledger.js';
import { SendService } from './send-service.js';
import { createMessagingStores } from './stores/factory.js';

export interface MessagingDomainDeps extends Partial<MessagingIngressWakeDeps> {
  readonly messageStore: IMessageStore;
  readonly redis?: RedisClient;
  /** Event log retention per thread (events beyond this are trimmed; stale+snapshot covers the gap). */
  readonly retentionCount?: number;
}

/**
 * F202 C1 gaps A/B: the wake collaborators are offered flat at this K-2 assembly point, and are
 * only honoured as a complete set. A partial set would silently derive a target it cannot deliver.
 */
function ingressWakeDeps(deps: MessagingDomainDeps): MessagingIngressWakeDeps | undefined {
  if (!deps.invokeTrigger || !deps.getDefaultCatId || !deps.getMentionPatterns) return undefined;
  return {
    invokeTrigger: deps.invokeTrigger,
    getDefaultCatId: deps.getDefaultCatId,
    getMentionPatterns: deps.getMentionPatterns,
    ...(deps.socketManager === undefined ? {} : { socketManager: deps.socketManager }),
    ...(deps.threadStore === undefined ? {} : { threadStore: deps.threadStore }),
  };
}

export class MessagingService {
  private readonly handles: HandleService;
  private readonly sendService: SendService;
  private readonly appendService: AppendService;
  private readonly stream: EventStreamService;

  constructor(deps: MessagingDomainDeps) {
    const stores = createMessagingStores(deps.redis);
    const ledger = new MessagingLedger(stores.ledger);
    this.handles = new HandleService(stores.handles, stores.cursors);
    const ingressWake = ingressWakeDeps(deps);
    this.sendService = new SendService({
      messageStore: deps.messageStore,
      handles: this.handles,
      ledger,
      events: stores.events,
      ...(deps.retentionCount !== undefined ? { retentionCount: deps.retentionCount } : {}),
      ...(ingressWake === undefined ? {} : { ingressWake }),
    });
    this.appendService = new AppendService({
      messageStore: deps.messageStore,
      ledger,
      handles: this.handles,
      events: stores.events,
      appendLock: stores.appendLock,
      ...(deps.retentionCount !== undefined ? { retentionCount: deps.retentionCount } : {}),
    });
    this.stream = new EventStreamService({
      events: stores.events,
      cursors: stores.cursors,
      handles: this.handles,
      messageStore: deps.messageStore,
    });
  }

  // ── Handle issuance (K-2 control plane calls these) ──

  issueThreadHandle(input: IssueThreadHandleInput): Promise<{ handleId: string }> {
    return this.handles.issueThreadHandle(input);
  }

  issueConnectorBindingHandle(input: IssueConnectorBindingHandleInput): Promise<{ handleId: string }> {
    return this.handles.issueConnectorBindingHandle(input);
  }

  revokeHandle(handleId: string): Promise<void> {
    return this.handles.revoke(handleId);
  }

  // ── messaging.* call surface ──

  send(ctx: PluginCallContext, draft: unknown): Promise<SendReceipt> {
    return this.sendService.send(ctx, draft);
  }

  appendElements(ctx: PluginCallContext, input: unknown): Promise<AppendReceipt> {
    return this.appendService.appendElements(ctx, input);
  }

  // ── Output event subscription surface ──

  subscribe(ctx: PluginCallContext, handleId: string): Promise<SubscribeResult> {
    return this.stream.subscribe(ctx, handleId);
  }

  read(ctx: PluginCallContext, subscriptionId: string, options: { limit?: number }): Promise<ReadResult> {
    return this.stream.read(ctx, subscriptionId, options);
  }

  ack(ctx: PluginCallContext, subscriptionId: string, token: string): Promise<void> {
    return this.stream.ack(ctx, subscriptionId, token);
  }

  snapshot(ctx: PluginCallContext, subscriptionId: string): Promise<SnapshotResult> {
    return this.stream.snapshot(ctx, subscriptionId);
  }

  snapshotPage(ctx: PluginCallContext, input: M0CSnapshotInput): Promise<M0CSnapshotResult> {
    return this.stream.snapshotPage(ctx, input);
  }
}

export function createMessagingDomain(deps: MessagingDomainDeps): MessagingService {
  return new MessagingService(deps);
}
