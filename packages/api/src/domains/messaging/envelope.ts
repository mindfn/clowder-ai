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

/** Strict shape written into StoredMessage.extra.pluginMessage by SendService/AppendService. */
export interface PluginMessageExtra {
  readonly instanceId: string;
  readonly revision: number;
  readonly provenance: MessageProvenance;
  readonly elements: readonly MessageElement[];
  /** operationIds already applied — INV-12 replay guard inside the append lock. */
  readonly appendOps: readonly string[];
}

/** Runtime narrowing for extra.pluginMessage (fail-closed: malformed → null). */
export function readPluginMessageExtra(msg: StoredMessage): PluginMessageExtra | null {
  const raw = msg.extra?.pluginMessage;
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw as Record<string, unknown>;
  if (typeof candidate.instanceId !== 'string') return null;
  if (typeof candidate.revision !== 'number' || !Number.isInteger(candidate.revision)) return null;
  if (!Array.isArray(candidate.elements)) return null;
  if (!candidate.provenance || typeof candidate.provenance !== 'object') return null;
  if (!Array.isArray(candidate.appendOps)) return null;
  return raw as unknown as PluginMessageExtra;
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
      payload: { provenance: plugin.provenance, elements: plugin.elements },
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
