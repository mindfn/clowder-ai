/**
 * Plugin Messaging Contract Types — v0.1 candidate mirror (K-1 / F258)
 *
 * Truth source: zts212653/clowder-ai-plugins main 189f25d, proposal §3.1.
 * PIN-TODO(K-1 merge gate): once contract v0.1 is published (C-1 双签 merge →
 * registry-verified publish), replace this local mirror with the published
 * package types and run its conformance fixtures. Until then this file IS the
 * kernel-side draft, kept in lockstep with the C-1 candidate schema.
 *
 * Design decisions D-1..D-7: docs/features/F258-plugin-messaging-domain.md
 */

// ── Provenance ──

/** Epistemic standing of content (§3.1/§3.2a). C-1 alignment point. */
export type EpistemicStatus = 'observation' | 'user_intent' | 'inference';

/** External platform coordinates carried by connector ingress (§3.1). */
export interface ExternalSourceAddress {
  readonly connectorId: string;
  readonly chatId: string;
  readonly messageId?: string;
}

/**
 * Where content originated. Host-validated at send time (D-4):
 * - thread_handle sends: must be absent or `plugin` with the caller's own instanceId
 * - connector_binding sends: must be `external` matching the binding record
 * - `host` can never be declared by a draft
 */
export type ProvenanceOrigin =
  | { readonly kind: 'plugin'; readonly instanceId: string }
  | { readonly kind: 'external'; readonly connectorId: string; readonly sourceAddress?: ExternalSourceAddress }
  | { readonly kind: 'host' };

export interface MessageProvenance {
  readonly origin: ProvenanceOrigin;
  readonly epistemicStatus: EpistemicStatus;
}

/** Draft-side provenance: origin optional (host stamps/validates it). */
export interface DraftProvenance {
  readonly origin?: ProvenanceOrigin;
  readonly epistemicStatus: EpistemicStatus;
}

// ── Elements ──

/** v0 element kind registry (D-5). C-1 alignment point. */
export type ElementKind = 'text' | 'media_ref' | 'rich_block';

export interface MessageElement {
  /** Stable id, unique within the message. Referenced by derivedFromElementId. */
  readonly elementId: string;
  readonly kind: ElementKind;
  readonly payload: Readonly<Record<string, unknown>>;
  /**
   * Element-level epistemic override; absent = inherit payload provenance.
   * Appends claiming non-inference status MUST derive from an element of
   * equal status (INV-7, no provenance whitewashing).
   */
  readonly epistemicStatus?: EpistemicStatus;
  /** Must reference an already-persisted elementId of the same message. */
  readonly derivedFromElementId?: string;
}

// ── Payload (shared content model: Draft and Envelope are two phases) ──

export interface MessagePayload {
  readonly provenance: MessageProvenance;
  readonly elements: readonly MessageElement[];
  readonly correlationId?: string;
  readonly causationId?: string;
}

export interface DraftPayload {
  readonly provenance: DraftProvenance;
  readonly elements: readonly MessageElement[];
  readonly correlationId?: string;
  readonly causationId?: string;
}

// ── Addressing (host-issued handles only — no bare threadId channel) ──

export type MessageAddress =
  | { readonly kind: 'thread_handle'; readonly handle: string }
  | { readonly kind: 'connector_binding'; readonly handle: string };

// ── Audience (two-phase: drafts can never express `system`) ──

export type DraftAudience =
  | { readonly kind: 'public' }
  | { readonly kind: 'whisper'; readonly targets: readonly string[] };

export type CanonicalAudience =
  | { readonly kind: 'public' }
  | { readonly kind: 'whisper'; readonly targets: readonly string[] }
  | { readonly kind: 'system' };

// ── Draft (plugin submits) ──

export interface MessageDraft {
  readonly address: MessageAddress;
  readonly draftAudience?: DraftAudience;
  /** Required. Stable across retries/restarts; host dedupes and returns the same receipt. */
  readonly idempotencyKey: string;
  /** External-source provenance only — NOT an idempotency key (§3.1). */
  readonly sourceEventId?: string;
  readonly replyTo?: string;
  readonly payload: DraftPayload;
}

// ── Envelope (host-generated canonical) ──

export type ActorRef =
  | { readonly kind: 'user'; readonly id: string }
  | { readonly kind: 'cat'; readonly id: string }
  | { readonly kind: 'plugin'; readonly id: string }
  | { readonly kind: 'device'; readonly id: string }
  | { readonly kind: 'system'; readonly id: string };

export interface MessageEnvelope {
  readonly messageId: string;
  readonly revision: number;
  readonly threadId: string;
  readonly replyTo?: string;
  /** Bound by the host — never taken from the draft. */
  readonly actor: ActorRef;
  /** Derived by the host; `system` is host-only (INV-2). */
  readonly audience: CanonicalAudience;
  /** RFC3339 UTC. Timezone is presentation context (§3.1). */
  readonly occurredAt: string;
  readonly payload: MessagePayload;
}

// ── Output events (host event stream) ──

export interface MessagePublishEvent {
  readonly eventId: string;
  /** Host-assigned, strictly monotonic per thread (INV-3). */
  readonly sequence: number;
  readonly type: 'message.publish';
  readonly envelope: MessageEnvelope;
}

export interface MessageElementsAppendEvent {
  readonly eventId: string;
  readonly sequence: number;
  readonly type: 'message.elements.append';
  readonly messageId: string;
  readonly threadId: string;
  readonly operationId: string;
  readonly baseRevision?: number;
  /** Revision after this append was applied. */
  readonly revision: number;
  readonly elements: readonly MessageElement[];
}

export type MessageOutputEvent = MessagePublishEvent | MessageElementsAppendEvent;

/** Event as submitted to the log — the store assigns `sequence` atomically (INV-3). */
export type MessageOutputEventInput =
  | Omit<MessagePublishEvent, 'sequence'>
  | Omit<MessageElementsAppendEvent, 'sequence'>;

// ── Receipts ──

export interface SendReceipt {
  readonly messageId: string;
  readonly threadId: string;
  readonly revision: number;
  /** Sequence of the publish event. Absent for whisper sends (not event-streamed in v0). */
  readonly publishSequence?: number;
}

export interface AppendReceipt {
  readonly messageId: string;
  readonly revision: number;
  readonly appendSequence?: number;
  readonly appliedElementIds: readonly string[];
}

// ── AppendElements input ──

/** Host-issued capability reference for one plugin-owned message. */
export interface MessageHandle {
  readonly kind: 'message';
  readonly token: string;
}

export interface AppendElementsInput {
  readonly handle: MessageHandle;
  /** Idempotency scope: (pluginInstanceId, messageId, operationId). */
  readonly operationId: string;
  /** Optimistic concurrency: mismatch → CONFLICT, zero mutation (INV-10). */
  readonly baseRevision?: number;
  readonly elements: readonly MessageElement[];
}

// ── Subscription surface (consumed by K-2 broker) ──

export interface SubscribeResult {
  readonly subscriptionId: string;
}

export interface ReadResult {
  readonly events: readonly MessageOutputEvent[];
  /** Opaque, subscription-local (INV-5). Null when no events were delivered. */
  readonly ackToken: string | null;
  /** Cursor fell behind the retention window — resync via snapshot (INV-9). */
  readonly stale: boolean;
}

export interface SnapshotResult {
  readonly envelopes: readonly MessageEnvelope[];
  /** Cursor position after catch-up; subsequent reads resume from here. */
  readonly resumeSequence: number;
}

// ── Call context & grants ──

/** Identity bound by the host broker per call — never self-reported inside payloads. */
export interface PluginCallContext {
  readonly pluginInstanceId: string;
}

/** Grant projection carried by a handle (control plane hands issuance to K-2). */
export interface HandleScope {
  readonly canSend: boolean;
  readonly canSubscribe: boolean;
  /** Whisper allowed-target set; whisper drafts must target a subset (§3.1). */
  readonly allowedWhisperTargets?: readonly string[];
}

// ── Errors ──

export type MessagingErrorCode =
  | 'VALIDATION'
  | 'PERMISSION'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RETRYABLE_INFLIGHT'
  | 'STALE_CURSOR';

export class MessagingError extends Error {
  readonly code: MessagingErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(code: MessagingErrorCode, message: string, details?: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = 'MessagingError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

// ── Bounds (D-6, fail-closed). C-1 alignment point. ──

export const MESSAGING_BOUNDS = {
  maxElementsPerOperation: 32,
  maxElementPayloadBytes: 64 * 1024,
  maxTotalPayloadBytes: 256 * 1024,
  maxWhisperTargets: 16,
  maxIdempotencyKeyLength: 200,
  maxElementIdLength: 128,
  /** Cumulative caps across appends — a message can never grow unboundedly (fail-closed). */
  maxElementsPerMessage: 32,
  maxAppendOpsPerMessage: 64,
} as const;
