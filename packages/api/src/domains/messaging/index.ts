/**
 * Plugin Messaging domain (K-1 / F258) — public surface.
 * Truth source: clowder-ai-plugins proposal §3.1 (189f25d).
 */

export type {
  AppendElementsInput,
  AppendReceipt,
  CanonicalAudience,
  DraftAudience,
  ElementKind,
  EpistemicStatus,
  HandleScope,
  MessageAddress,
  MessageDraft,
  MessageElement,
  MessageEnvelope,
  MessageOutputEvent,
  MessagingErrorCode,
  PluginCallContext,
  ReadResult,
  SendReceipt,
  SnapshotResult,
  SubscribeResult,
} from './contract/types.js';
export { MESSAGING_BOUNDS, MessagingError } from './contract/types.js';
export { projectEnvelope } from './envelope.js';
export type { IssueConnectorBindingHandleInput, IssueThreadHandleInput } from './handles.js';
export { createMessagingDomain, type MessagingDomainDeps, MessagingService } from './messaging-service.js';
