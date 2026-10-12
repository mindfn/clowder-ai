import { snapshotPluginProtocolData } from '../../../plugin/carrier/plugin-protocol-data.js';
import { type MessageDeliveryBoundary, parseMessageDeliveryBoundary } from './message-delivery-boundary.js';
import type { StoredMessage } from './ports/MessageStore.js';

/** Message-owned output receipt. Only the dedicated terminal CAS may advance its state. */
export interface PublicInvocationOutputV1 {
  readonly v: 1;
  readonly state: 'pending_terminal' | 'committed' | 'abandoned';
  readonly sourceMessageId: string;
  readonly childInvocationId: string;
  readonly outputMessageId: string;
  readonly boundary: MessageDeliveryBoundary;
}

/** Presence is irreversible: an invalid public marker must never become ordinary output. */
export function hasPublicInvocationOutput(extra: StoredMessage['extra']): boolean {
  return extra !== undefined && extra !== null && 'publicOutputV1' in extra;
}

function parsePublicBoundary(value: unknown): MessageDeliveryBoundary | undefined {
  try {
    const captured = snapshotPluginProtocolData(value);
    const boundary = parseMessageDeliveryBoundary(captured);
    return boundary && Object.keys(captured as object).length === 7 ? Object.freeze(boundary) : undefined;
  } catch {
    return undefined;
  }
}

export function parsePublicInvocationOutput(value: unknown): PublicInvocationOutputV1 | undefined {
  try {
    const row = snapshotPluginProtocolData(value) as PublicInvocationOutputV1;
    if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).length !== 6) return undefined;
    if (row.v !== 1 || !['pending_terminal', 'committed', 'abandoned'].includes(row.state)) return undefined;
    for (const key of ['sourceMessageId', 'childInvocationId', 'outputMessageId'] as const) {
      if (typeof row[key] !== 'string' || row[key].length === 0) return undefined;
    }
    const boundary = parsePublicBoundary(row.boundary);
    if (!boundary) return undefined;
    if (boundary.sourceMessageId !== row.sourceMessageId || boundary.turnInvocationId !== row.childInvocationId)
      return undefined;
    return row;
  } catch {
    return undefined;
  }
}

/** Validate the receipt against the output itself, not just the caller's source selection. */
export function committedPublicInvocationOutput(message: StoredMessage): PublicInvocationOutputV1 | undefined {
  const property = message.extra && Object.getOwnPropertyDescriptor(message.extra, 'publicOutputV1');
  const receipt = property && 'value' in property ? parsePublicInvocationOutput(property.value) : undefined;
  if (!receipt || receipt.state !== 'committed') return undefined;
  const installed = message.extra && Object.getOwnPropertyDescriptor(message.extra, 'deliveryBoundary');
  const boundary = installed && 'value' in installed ? parsePublicBoundary(installed.value) : undefined;
  if (
    !boundary ||
    Object.keys(boundary).some(
      (key) =>
        boundary[key as keyof MessageDeliveryBoundary] !== receipt.boundary[key as keyof MessageDeliveryBoundary],
    )
  )
    return undefined;
  if (
    message.id !== receipt.outputMessageId ||
    message.userId !== boundary.userId ||
    message.threadId !== boundary.threadId ||
    message.catId !== boundary.catId ||
    message.origin !== 'stream' ||
    message.extra?.stream?.turnInvocationId !== receipt.childInvocationId ||
    message.extra?.causal?.kind !== 'invocation_reply' ||
    message.extra.causal.triggerMessageId !== receipt.sourceMessageId ||
    (message.extra.causal.triggerThreadId !== undefined && message.extra.causal.triggerThreadId !== message.threadId) ||
    (message.replyTo !== undefined && message.replyTo !== receipt.sourceMessageId) ||
    message.deletedAt ||
    message._tombstone ||
    message.recall ||
    message.deliveryStatus === 'canceled'
  )
    return undefined;
  return receipt;
}
