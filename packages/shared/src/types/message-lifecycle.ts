import type { CatRoutingError } from './cat-routing.js';
import type { MessageContent } from './message.js';

export type LifecycleQueuePriority = 'urgent' | 'normal';

export type LifecycleMessageFrom =
  | { readonly kind: 'user'; readonly userId: string }
  | { readonly kind: 'agent'; readonly catId: string }
  | {
      readonly kind: 'external';
      readonly connectorId: string;
      readonly sender?: { readonly id: string; readonly name?: string };
      readonly address?: { readonly chatId: string; readonly messageId?: string };
    }
  | { readonly kind: 'plugin'; readonly instanceId: string }
  | { readonly kind: 'system'; readonly service: string };

export interface LifecycleInlinePayload {
  readonly type: 'inline';
  readonly body: readonly MessageContent[];
  readonly routingWarnings?: readonly CatRoutingError[];
}

export interface LifecycleMessageRefPayload {
  readonly type: 'message_ref';
  readonly messageId: string;
}

interface LifecycleQueueEntryBase {
  readonly id: string;
  readonly threadId: string;
  readonly from: LifecycleMessageFrom;
  readonly targets: readonly string[];
  readonly ownerAuthProvenance: 'strict' | 'compatibility_fallback' | 'unknown';
  readonly priority: LifecycleQueuePriority;
  readonly enqueuedAt: number;
}

export type LifecycleQueueEntry =
  | (LifecycleQueueEntryBase & {
      readonly kind: 'conversation_input';
      readonly sourceRecordId: string;
      readonly payload: LifecycleInlinePayload;
      readonly position?: number;
    })
  | (LifecycleQueueEntryBase & {
      readonly kind: 'message_wake';
      readonly payload: LifecycleMessageRefPayload;
      readonly position?: number;
    })
  | (LifecycleQueueEntryBase & {
      readonly kind: 'private_input';
      readonly payload: LifecycleInlinePayload;
    });

export interface LifecycleQueueSnapshot {
  readonly revision: string;
  readonly entries: readonly LifecycleQueueEntry[];
  /** Exact visible rows that the server declared reorderable at this revision. */
  readonly reorderableVisibleEntryIds: readonly string[];
}

export interface ReorderVisibleLifecycleEntriesCommand {
  readonly threadId: string;
  readonly expectedQueueRevision: string;
  readonly orderedVisibleEntryIds: readonly string[];
}

export type LifecycleDispatchRef =
  | { readonly targetId: string; readonly phase: 'assigned' }
  | { readonly targetId: string; readonly phase: 'dispatched'; readonly statusMessageId: string }
  | { readonly targetId: string; readonly phase: 'settled'; readonly statusMessageId: string };

export interface LifecycleMessageMetadata {
  readonly orderKey: string;
  readonly from: LifecycleMessageFrom;
  readonly dispatchRefs?: readonly LifecycleDispatchRef[];
  readonly producerInvocationId?: string;
}

export interface LifecycleDeliveryFailureResult {
  readonly kind: 'delivery_failure';
  readonly status: 'failed';
  readonly id: string;
  readonly threadId: string;
  readonly orderKey: string;
  readonly sourceEntryId: string;
  readonly inputMessageId: string;
  readonly requestedTargets: readonly string[];
  readonly reason:
    | 'no_available_target'
    | 'invalid_explicit_target'
    | 'control_carrier_missing'
    | 'control_carrier_replaced';
  readonly body: readonly MessageContent[];
  readonly createdAt: number;
}

export interface LifecycleResponseBubble {
  readonly id: string;
  readonly threadId: string;
  readonly orderKey: string;
  readonly invocationId: string;
  readonly targetId: string;
  readonly inputEntryIds: readonly string[];
  readonly inputMessageIds: readonly string[];
  readonly body: readonly MessageContent[];
  readonly status: 'processing' | 'completed' | 'failed' | 'canceled' | 'interrupted';
  readonly dispatchRefs?: readonly LifecycleDispatchRef[];
  readonly startedAt: number;
  readonly completedAt?: number;
  readonly reason?: string;
}

export interface LifecycleActiveRun {
  readonly threadId: string;
  readonly targetId: string;
  readonly invocationId: string;
  readonly responseMessageId: string;
  readonly inputEntryIds: readonly string[];
  readonly inputMessageIds: readonly string[];
  readonly privateInputEntryIds: readonly string[];
  readonly startedAt: number;
}

export type LifecycleWriterEpoch = 'legacy' | 'migrating' | 'live';

export type LifecycleWriterEpochState =
  | { readonly epoch: 'legacy' }
  | { readonly epoch: 'migrating'; readonly migrationLeaseId: string }
  | { readonly epoch: 'live'; readonly migrationLeaseId: string };

export interface StructuredOwnerAdmissionBinding {
  readonly invocationId: string;
  readonly entryId: string;
  readonly targetId: string;
  readonly ownerKind: string;
  readonly ownerSubjectRef: string;
  readonly leaseId?: string;
  readonly generation: number;
  readonly frozenPredicate: {
    readonly kind: string;
    readonly value: string;
    readonly headSha?: string;
  };
  readonly principal: {
    readonly tenantId: string;
    readonly routeId: string;
    readonly callbackPrincipalId: string;
  };
  readonly admittedAt: number;
}
