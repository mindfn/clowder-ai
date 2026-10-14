import type { ChatMessage } from '@/stores/chat-types';

export type ReplyHandoffKind = 'handoff' | 'queued' | 'parallel';

export interface ReplyHandoffProjection {
  kind: ReplyHandoffKind;
  targetCatIds: readonly string[];
  sourceMessageIds: readonly string[];
}

export interface ReplyHandoffTimelineProjection {
  /** The reply (or standalone first carrier) that renders each projection. */
  renderByMessageId: ReadonlyMap<string, readonly ReplyHandoffProjection[]>;
  /** Persisted carrier rows that the v2 presentation replaces with the projection above. */
  hiddenRoutingMessageIds: ReadonlySet<string>;
}

interface RoutingCarrier {
  message: ChatMessage;
  fromCatId: string;
  targetCatId: string;
  kind: ReplyHandoffKind;
}

interface HandoffGroup {
  ownerMessageId?: string;
  fromCatId: string;
  kind: ReplyHandoffKind;
  timestamp: number;
  invocationId?: string;
  carriers: RoutingCarrier[];
}

const EMPTY_PROJECTION: ReplyHandoffTimelineProjection = {
  renderByMessageId: new Map(),
  hiddenRoutingMessageIds: new Set(),
};

function routingCarrier(message: ChatMessage): RoutingCarrier | undefined {
  const route = message.extra?.a2aRouting;
  if (message.type !== 'system' || !route?.fromCatId || !route.targetCatId) return undefined;
  if (message.extra?.systemKind !== 'a2a_routing' && !route) return undefined;
  const structured = route.routing;
  const kind: ReplyHandoffKind =
    structured?.mode === 'parallel' || message.content.includes('⇉')
      ? 'parallel'
      : (structured?.mode === 'serial' && structured.index > 1) || message.content.includes('⇢')
        ? 'queued'
        : 'handoff';
  return { message, fromCatId: route.fromCatId, targetCatId: route.targetCatId, kind };
}

function replyOwnsRoute(reply: ChatMessage, route: RoutingCarrier): boolean {
  if (reply.type !== 'assistant' || reply.catId !== route.fromCatId) return false;
  const invocationId = route.message.extra?.a2aRouting?.invocationId;
  if (!invocationId) return true;
  return (
    reply.extra?.stream?.invocationId === invocationId ||
    reply.extra?.stream?.turnInvocationId === invocationId ||
    reply.extra?.invocationReconciliation?.invocationId === invocationId
  );
}

function findOwnerMessage(
  messages: readonly ChatMessage[],
  routeIndex: number,
  route: RoutingCarrier,
): ChatMessage | undefined {
  const invocationId = route.message.extra?.a2aRouting?.invocationId;
  for (let index = routeIndex - 1; index >= 0; index -= 1) {
    const candidate = messages[index];
    if (!candidate) continue;
    if (routingCarrier(candidate)) continue;
    if (replyOwnsRoute(candidate, route)) return candidate;
    // Without an invocation coordinate, only the immediately adjacent reply is safe to project.
    if (!invocationId) return undefined;
  }
  return undefined;
}

function sameParallelBatch(left: HandoffGroup | undefined, right: Omit<HandoffGroup, 'carriers'>): boolean {
  return Boolean(
    left &&
      left.kind === 'parallel' &&
      right.kind === 'parallel' &&
      left.ownerMessageId === right.ownerMessageId &&
      left.fromCatId === right.fromCatId &&
      left.invocationId === right.invocationId &&
      left.timestamp === right.timestamp,
  );
}

/**
 * Build the v2 read-side projection without mutating or merging the persisted `a2a_routing` messages.
 *
 * Exact invocation coordinates win. Legacy/parallel carriers without one are attached only when the
 * immediately preceding non-routing row is the emitting cat's reply; otherwise the carrier stays at
 * its original timeline position as a muted standalone line. A caller that supplies presentation
 * eligibility gets the same fallback when the owner exists but cannot draw ReplyLayers.
 */
export function projectReplyHandoffs(
  messages: readonly ChatMessage[],
  canRenderInlineOwner: (message: ChatMessage) => boolean,
): ReplyHandoffTimelineProjection {
  if (messages.length === 0) return EMPTY_PROJECTION;

  const groups: HandoffGroup[] = [];
  messages.forEach((message, index) => {
    const carrier = routingCarrier(message);
    if (!carrier) return;
    const route = message.extra?.a2aRouting;
    const owner = findOwnerMessage(messages, index, carrier);
    const next = {
      ownerMessageId: owner && canRenderInlineOwner(owner) ? owner.id : undefined,
      fromCatId: carrier.fromCatId,
      kind: carrier.kind,
      timestamp: message.timestamp,
      ...(route?.invocationId ? { invocationId: route.invocationId } : {}),
    };
    const previous = groups.at(-1);
    if (previous && sameParallelBatch(previous, next)) previous.carriers.push(carrier);
    else groups.push({ ...next, carriers: [carrier] });
  });

  const mutableRender = new Map<string, ReplyHandoffProjection[]>();
  const hidden = new Set<string>();
  for (const group of groups) {
    const renderMessageId = group.ownerMessageId ?? group.carriers[0]?.message.id;
    if (!renderMessageId) continue;
    const projection: ReplyHandoffProjection = {
      kind: group.kind,
      targetCatIds: group.carriers.map((carrier) => carrier.targetCatId),
      sourceMessageIds: group.carriers.map((carrier) => carrier.message.id),
    };
    mutableRender.set(renderMessageId, [...(mutableRender.get(renderMessageId) ?? []), projection]);
    const hiddenCarriers = group.ownerMessageId ? group.carriers : group.carriers.slice(1);
    for (const carrier of hiddenCarriers) hidden.add(carrier.message.id);
  }
  const result: ReplyHandoffTimelineProjection = {
    renderByMessageId: mutableRender,
    hiddenRoutingMessageIds: hidden,
  };
  return result;
}
