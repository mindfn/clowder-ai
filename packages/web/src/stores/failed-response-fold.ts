import type { ChatMessage } from './chat-types';

/**
 * Presentation rule over stored responses: a provider/liveness retry can store a failed
 * auxiliary response before the Queue-owned response starts. The durable frontier chain
 * is exact — source → auxiliary failure(s) → source-bound final failure — so that closed
 * chain renders as the final failure alone, carrying every attempt's body. Everything
 * else renders exactly as stored.
 */

type FailedFrontierFoldOwnerByRecord = Map<ChatMessage, ChatMessage>;

function exactRecordsById(records: readonly ChatMessage[]): Map<string, ChatMessage | null> {
  const byId = new Map<string, ChatMessage | null>();
  for (const record of records) {
    byId.set(record.id, byId.has(record.id) ? null : record);
  }
  return byId;
}

function exactSourceBoundFinalFailure(
  source: ChatMessage,
  targetId: string,
  statusMessageId: string,
  byId: ReadonlyMap<string, ChatMessage | null>,
): ChatMessage | undefined {
  const final = byId.get(statusMessageId);
  const lifecycle = final?.lifecycle;
  if (!final || lifecycle?.kind !== 'response' || lifecycle.status !== 'failed') return undefined;
  if (lifecycle.targetId !== targetId || final.catId !== targetId || final.origin === 'callback') return undefined;
  if (final.replyTo !== source.id || !lifecycle.inputMessageIds.includes(source.id)) return undefined;
  return final;
}

function isMatchingAuxiliaryFailure(
  candidate: ChatMessage | null | undefined,
  final: ChatMessage,
): candidate is ChatMessage {
  const lifecycle = candidate?.lifecycle;
  const finalLifecycle = final.lifecycle;
  if (!candidate || lifecycle?.kind !== 'response' || finalLifecycle?.kind !== 'response') return false;
  if (lifecycle.status !== 'failed' || lifecycle.reason !== finalLifecycle.reason) return false;
  if (lifecycle.targetId !== finalLifecycle.targetId || lifecycle.inputMessageIds.length !== 0) return false;
  return candidate.catId === final.catId && candidate.origin !== 'callback' && candidate.replyTo == null;
}

function collectFailedFrontier(
  sourceMessageId: string,
  final: ChatMessage,
  byId: ReadonlyMap<string, ChatMessage | null>,
): ChatMessage[] | undefined {
  const folded: ChatMessage[] = [];
  const visited = new Set<string>();
  let frontierId = final.extra?.freshness?.priorFrontierMessageId;
  while (frontierId && frontierId !== sourceMessageId && !visited.has(frontierId)) {
    visited.add(frontierId);
    const candidate = byId.get(frontierId);
    if (!isMatchingAuxiliaryFailure(candidate, final)) return undefined;
    folded.unshift(candidate);
    frontierId = candidate.extra?.freshness?.priorFrontierMessageId;
  }
  return frontierId === sourceMessageId && folded.length > 0 ? folded : undefined;
}

function addFoldClaims(
  records: readonly ChatMessage[],
  owner: ChatMessage,
  claims: Map<ChatMessage, ChatMessage>,
  ambiguous: Set<ChatMessage>,
): void {
  for (const record of records) {
    const existing = claims.get(record);
    if (existing && existing !== owner) ambiguous.add(record);
    else claims.set(record, owner);
  }
}

/**
 * A provider/liveness retry can publish one failed auxiliary response before
 * the Queue-owned response starts. The durable frontier chain is exact:
 * source -> auxiliary failure(s) -> source-bound final failure. Fold only that
 * closed chain, preserving every attempt body in the final response bubble.
 */
function buildFailedFrontierFoldOwners(records: readonly ChatMessage[]): FailedFrontierFoldOwnerByRecord {
  const byId = exactRecordsById(records);
  const claims = new Map<ChatMessage, ChatMessage>();
  const ambiguous = new Set<ChatMessage>();

  for (const source of records) {
    const refs = source.lifecycle?.dispatchRefs ?? [];
    for (const ref of refs) {
      if (ref.phase !== 'settled') continue;
      const final = exactSourceBoundFinalFailure(source, ref.targetId, ref.statusMessageId, byId);
      if (!final) continue;
      const folded = collectFailedFrontier(source.id, final, byId);
      if (folded) addFoldClaims([...folded, final], final, claims, ambiguous);
    }
  }

  for (const record of ambiguous) claims.delete(record);
  return claims;
}

function foldBodies(owner: ChatMessage, attempts: readonly ChatMessage[]): ChatMessage {
  const ordered = [...attempts, owner];
  const content = ordered
    .map((record) => record.content)
    .filter((part) => part.trim().length > 0)
    .join('\n\n');
  const thinking = ordered
    .map((record) => record.thinking)
    .filter((part): part is string => Boolean(part?.trim()))
    .join('\n\n');
  const seenTools = new Set<string>();
  const toolEvents = ordered.flatMap((record) =>
    (record.toolEvents ?? []).filter((event) => {
      const key = `${event.type}:${event.id}`;
      if (seenTools.has(key)) return false;
      seenTools.add(key);
      return true;
    }),
  );
  return {
    ...owner,
    content,
    ...(thinking ? { thinking } : {}),
    ...(toolEvents.length > 0 ? { toolEvents } : {}),
    projectionSourceMessageIds: ordered.map((record) => record.id),
  };
}

export function foldFailedResponseRetries(messages: readonly ChatMessage[]): ChatMessage[] {
  const owners = buildFailedFrontierFoldOwners(messages);
  if (owners.size === 0) return messages as ChatMessage[];
  const attemptsByOwner = new Map<ChatMessage, ChatMessage[]>();
  for (const [record, owner] of owners) {
    if (record === owner) continue;
    const attempts = attemptsByOwner.get(owner) ?? [];
    attempts.push(record);
    attemptsByOwner.set(owner, attempts);
  }
  const folded: ChatMessage[] = [];
  for (const message of messages) {
    const owner = owners.get(message);
    if (owner && owner !== message) continue;
    const attempts = attemptsByOwner.get(message);
    folded.push(attempts ? foldBodies(message, attempts) : message);
  }
  return folded;
}
