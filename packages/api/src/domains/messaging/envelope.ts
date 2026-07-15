/**
 * Plugin Messaging — envelope pure projection (K-1 / F258, D-1)
 *
 * MessageEnvelope is a PROJECTION of StoredMessage — the message store stays
 * the single truth source (P4); no second envelope store exists. Plugin-sent
 * messages carry their canonical payload in extra.pluginMessage; user/cat
 * messages project deterministically (snapshot support).
 *
 * Epistemic mapping for host-relayed messages (C-1 alignment point):
 * user → user_intent, cat → inference, origin always { kind: 'host' }.
 */

import type { StoredMessage } from '../cats/services/stores/ports/MessageStore.js';
import type {
  CanonicalAudience,
  EpistemicStatus,
  MessageElement,
  MessageEnvelope,
  MessageProvenance,
} from './contract/types.js';

/** One applied append operation — the INV-12 replay guard AND replay reconstruction source. */
export interface AppendOpRecord {
  readonly operationId: string;
  /** elementIds this operation appended — replays rebuild receipts/events from the PERSISTED elements. */
  readonly elementIds: readonly string[];
  /** Original concurrency precondition; deterministic eventId must always reproduce identical event content. */
  readonly baseRevision?: number;
}

/** Strict shape written into StoredMessage.extra.pluginMessage by SendService/AppendService. */
export interface PluginMessageExtra {
  readonly instanceId: string;
  readonly revision: number;
  readonly provenance: MessageProvenance;
  readonly elements: readonly MessageElement[];
  /** External source provenance retained for audit; never used as the send idempotency key. */
  readonly sourceEventId?: string;
  readonly correlationId?: string;
  readonly causationId?: string;
  /** Applied operations in application order — INV-12 replay guard inside the append lock. */
  readonly appendOps: readonly AppendOpRecord[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function isEpistemicStatus(value: unknown): boolean {
  return value === 'observation' || value === 'user_intent' || value === 'inference';
}

function isOrigin(value: unknown): boolean {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  if (value.kind === 'host') return true;
  if (value.kind === 'plugin') return typeof value.instanceId === 'string';
  if (value.kind !== 'external' || typeof value.connectorId !== 'string') return false;
  if (value.sourceAddress === undefined) return true;
  if (!isRecord(value.sourceAddress)) return false;
  return (
    typeof value.sourceAddress.connectorId === 'string' &&
    typeof value.sourceAddress.chatId === 'string' &&
    isOptionalString(value.sourceAddress.messageId)
  );
}

function isProvenance(value: unknown): boolean {
  return isRecord(value) && isOrigin(value.origin) && isEpistemicStatus(value.epistemicStatus);
}

function isElement(value: unknown): boolean {
  if (!isRecord(value) || typeof value.elementId !== 'string') return false;
  if (value.kind !== 'text' && value.kind !== 'media_ref' && value.kind !== 'rich_block') return false;
  if (!isRecord(value.payload)) return false;
  if (value.kind === 'text' && typeof value.payload.text !== 'string') return false;
  if (value.epistemicStatus !== undefined && !isEpistemicStatus(value.epistemicStatus)) return false;
  return isOptionalString(value.derivedFromElementId);
}

function isAppendOp(value: unknown): boolean {
  if (!isRecord(value) || typeof value.operationId !== 'string' || !Array.isArray(value.elementIds)) return false;
  if (!value.elementIds.every((elementId) => typeof elementId === 'string')) return false;
  return (
    value.baseRevision === undefined ||
    (typeof value.baseRevision === 'number' && Number.isInteger(value.baseRevision) && value.baseRevision > 0)
  );
}

/** Single strict parser shared by memory projection and Redis hydration. */
export function parsePluginMessageExtra(raw: unknown): PluginMessageExtra | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.instanceId !== 'string') return null;
  if (typeof raw.revision !== 'number' || !Number.isInteger(raw.revision) || raw.revision < 1) return null;
  if (!isProvenance(raw.provenance)) return null;
  if (!Array.isArray(raw.elements) || raw.elements.length === 0 || !raw.elements.every(isElement)) return null;
  if (!Array.isArray(raw.appendOps) || !raw.appendOps.every(isAppendOp)) return null;
  if (!isOptionalString(raw.sourceEventId)) return null;
  if (!isOptionalString(raw.correlationId) || !isOptionalString(raw.causationId)) return null;
  return raw as unknown as PluginMessageExtra;
}

/** Runtime narrowing for extra.pluginMessage (fail-closed: malformed → null). */
export function readPluginMessageExtra(msg: StoredMessage): PluginMessageExtra | null {
  return parsePluginMessageExtra(msg.extra?.pluginMessage);
}

function audienceOf(msg: StoredMessage): CanonicalAudience {
  if (msg.visibility === 'whisper') {
    return { kind: 'whisper', targets: [...(msg.whisperTo ?? [])] };
  }
  return { kind: 'public' };
}

function hostRelayedEpistemic(msg: StoredMessage): EpistemicStatus {
  return msg.catId === null ? 'user_intent' : 'inference';
}

/**
 * Project a stored message to its canonical envelope.
 * Returns null for deleted/tombstoned messages and for malformed plugin extras.
 */
export function projectEnvelope(msg: StoredMessage): MessageEnvelope | null {
  if (msg.deletedAt !== undefined || msg._tombstone) return null;

  const base = {
    messageId: msg.id,
    threadId: msg.threadId,
    audience: audienceOf(msg),
    occurredAt: new Date(msg.timestamp).toISOString(),
    ...(msg.replyTo !== undefined ? { replyTo: msg.replyTo } : {}),
  };

  if (msg.extra?.pluginMessage !== undefined) {
    const plugin = readPluginMessageExtra(msg);
    if (!plugin) return null; // fail-closed: malformed plugin payloads never project
    return {
      ...base,
      revision: plugin.revision,
      actor: { kind: 'plugin', id: plugin.instanceId },
      payload: {
        provenance: plugin.provenance,
        elements: plugin.elements,
        ...(plugin.correlationId !== undefined ? { correlationId: plugin.correlationId } : {}),
        ...(plugin.causationId !== undefined ? { causationId: plugin.causationId } : {}),
      },
    };
  }

  return {
    ...base,
    revision: 1,
    actor: msg.catId === null ? { kind: 'user', id: msg.userId } : { kind: 'cat', id: msg.catId },
    payload: {
      provenance: { origin: { kind: 'host' }, epistemicStatus: hostRelayedEpistemic(msg) },
      elements: [{ elementId: `el_${msg.id}_0`, kind: 'text', payload: { text: msg.content } }],
    },
  };
}

/** Render draft elements to the plain-text content column (Hub display, D-1). */
export function renderElementsText(elements: readonly MessageElement[]): string {
  const parts: string[] = [];
  for (const el of elements) {
    if (el.kind === 'text' && typeof el.payload.text === 'string') {
      parts.push(el.payload.text);
    } else {
      parts.push(`[${el.kind}:${el.elementId}]`);
    }
  }
  return parts.join('\n');
}
