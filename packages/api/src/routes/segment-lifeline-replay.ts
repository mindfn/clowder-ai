/**
 * F257 Console 判据④ — Segment lifeline true-scene replay endpoint.
 *
 * Returns the event-time rendered segment content, source provenance,
 * variable bindings, nearby guard events, and captured conversation context
 * for a single (segmentId, threadId, turnId) observation.
 *
 * Auth: session-only (read surface, no mutation). Thread ownership is verified
 * via threadStore; cross-user access is rejected.
 *
 * Truth source: ReplaySnapshot (durable, owner-scoped, TTL=0). The compact
 * InjectionTraceSummary/detail is NOT the replay source; missing snapshots are
 * surfaced as a structured provenance gap rather than silently degrading to
 * current-state reconstruction.
 */

import type { ReplayProvenanceGap, ReplaySurroundingMessage, SegmentReplayResponse } from '@cat-cafe/shared';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { IMessageStore, StoredMessage } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import type { InjectionTraceStore } from '../domains/prompt-hooks/InjectionTraceStore.js';
import type {
  GuardRejectionEvent,
  GuardRejectionEventLog,
} from '../infrastructure/harness-eval/GuardRejectionEventLog.js';

export interface SegmentLifelineReplayRoutesOptions {
  traceStore?: InjectionTraceStore;
  guardRejectionLog?: GuardRejectionEventLog;
  /** Message store for surrounding conversation context. Absence = unavailable gap. */
  messageStore?: IMessageStore;
  /** Thread store for ownership authorization. Absence = 503. */
  threadStore?: IThreadStore;
}

const REPLAY_GUARD_WINDOW_MS = 120_000;
const PREVIEW_MAX_LEN = 200;

function requireSession(request: FastifyRequest, reply: FastifyReply): string | null {
  const userId = (request as FastifyRequest & { sessionUserId?: string }).sessionUserId;
  if (!userId) {
    reply.status(401).send({ error: 'Session required' });
    return null;
  }
  return userId;
}

async function requireThreadAccess(
  threadStore: IThreadStore | undefined,
  threadId: string,
  userId: string,
  reply: FastifyReply,
): Promise<boolean> {
  if (!threadStore) {
    reply.status(503).send({ error: 'Thread store unavailable' });
    return false;
  }
  try {
    const thread = await threadStore.get(threadId);
    if (!thread) {
      reply.status(404).send({ error: 'Thread not found' });
      return false;
    }
    if (thread.createdBy !== userId) {
      reply.status(403).send({ error: 'Access denied' });
      return false;
    }
    return true;
  } catch {
    reply.status(503).send({ error: 'Thread access check failed' });
    return false;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateTemplateVars(raw: unknown): { vars: Record<string, string> | null; gap: ReplayProvenanceGap | null } {
  if (raw === undefined) return { vars: null, gap: 'legacy-missing' };
  if (raw === null) return { vars: null, gap: 'invalid-present' };
  if (!isPlainObject(raw)) return { vars: null, gap: 'invalid-present' };
  for (const [key, value] of Object.entries(raw)) {
    if (typeof key !== 'string' || typeof value !== 'string') {
      return { vars: null, gap: 'invalid-present' };
    }
  }
  return { vars: raw as Record<string, string>, gap: null };
}

function validateVersion(raw: unknown): { version: number | null; gap: ReplayProvenanceGap | null } {
  if (raw === undefined) return { version: null, gap: 'legacy-missing' };
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0) return { version: null, gap: 'invalid-present' };
  return { version: raw, gap: null };
}

function validateStringField(raw: unknown): { value: string | null; gap: ReplayProvenanceGap | null } {
  if (raw === undefined) return { value: null, gap: 'legacy-missing' };
  if (raw === null) return { value: null, gap: 'invalid-present' };
  if (typeof raw !== 'string') return { value: null, gap: 'invalid-present' };
  return { value: raw, gap: null };
}

function validateSourceKind(raw: unknown): {
  value: SegmentReplayResponse['contentSourceKind'];
  gap: ReplayProvenanceGap | null;
} {
  if (raw === undefined) return { value: null, gap: 'legacy-missing' };
  if (raw === null) return { value: null, gap: null };
  const valid = ['template', 'override', 'content-var', 'file-fallback', 'native-l0', 'aggregate'] as const;
  if (!valid.includes(raw as (typeof valid)[number])) return { value: null, gap: 'invalid-present' };
  return { value: raw as SegmentReplayResponse['contentSourceKind'], gap: null };
}

function validateMessageAnchorId(raw: unknown): { value: string | null; gap: ReplayProvenanceGap | null } {
  if (raw === undefined || raw === null) return { value: null, gap: 'legacy-missing' };
  if (typeof raw !== 'string' || raw.length === 0) return { value: null, gap: 'invalid-present' };
  return { value: raw, gap: null };
}

function validateSurroundingMessageIds(raw: unknown): { value: string[] | null; gap: ReplayProvenanceGap | null } {
  if (raw === undefined) return { value: null, gap: 'legacy-missing' };
  if (raw === null) return { value: null, gap: 'invalid-present' };
  if (!Array.isArray(raw)) return { value: null, gap: 'invalid-present' };
  if (!raw.every((id) => typeof id === 'string' && id.length > 0)) return { value: null, gap: 'invalid-present' };
  return { value: raw as string[], gap: null };
}

function mapGuardEvent(event: GuardRejectionEvent): SegmentReplayResponse['guardEvents'][number] {
  return {
    eventId: event.eventId,
    kind: event.kind,
    guardId: event.guardId,
    catId: event.catId,
    timestamp: event.timestamp,
    attribution: 'window-correlated',
  };
}

function deriveMessageRole(msg: StoredMessage): ReplaySurroundingMessage['role'] {
  const author = msg.provenance?.author;
  if (author === 'system') return 'system';
  if (author === 'cat' || msg.catId != null) return 'assistant';
  return 'user';
}

function mapSurroundingMessage(msg: StoredMessage): ReplaySurroundingMessage {
  const preview = msg.content?.slice(0, PREVIEW_MAX_LEN) ?? '';
  const ellipsis = msg.content && msg.content.length > PREVIEW_MAX_LEN ? '…' : '';
  return {
    messageId: msg.id,
    role: deriveMessageRole(msg),
    catId: msg.catId,
    contentPreview: `${preview}${ellipsis}`,
    timestamp: msg.timestamp,
  };
}

async function fetchGuardEvents(
  log: GuardRejectionEventLog | undefined,
  threadId: string,
  catId: string,
  timestamp: number,
): Promise<{ events: SegmentReplayResponse['guardEvents']; gap: ReplayProvenanceGap | null }> {
  if (!log) return { events: [], gap: 'unavailable' };
  try {
    const events = await log.queryWindow({
      since: timestamp - REPLAY_GUARD_WINDOW_MS,
      until: timestamp + REPLAY_GUARD_WINDOW_MS,
      threadId,
      catId,
      limit: 50,
    });
    return { events: events.map(mapGuardEvent), gap: null };
  } catch {
    return { events: [], gap: 'unavailable' };
  }
}

async function fetchSurroundingMessages(
  store: IMessageStore | undefined,
  snapshotIds: string[] | null,
): Promise<{ messages: ReplaySurroundingMessage[] | null; gap: ReplayProvenanceGap | null }> {
  if (!store) return { messages: null, gap: 'unavailable' };
  if (!snapshotIds || snapshotIds.length === 0) return { messages: [], gap: null };
  try {
    const messages = await store.getByIds(snapshotIds);
    // Preserve snapshot order; drop missing messages (deletion) without failing.
    const byId = new Map(messages.map((m) => [m.id, m]));
    const ordered = snapshotIds.map((id) => byId.get(id)).filter((m): m is StoredMessage => m !== undefined);
    return { messages: ordered.map(mapSurroundingMessage), gap: null };
  } catch {
    return { messages: null, gap: 'unavailable' };
  }
}

export const segmentLifelineReplayRoutes: FastifyPluginAsync<SegmentLifelineReplayRoutesOptions> = async (
  app,
  opts,
) => {
  app.get('/api/segment-lifeline/:segmentId/replay', async (request, reply) => {
    const userId = requireSession(request, reply);
    if (!userId) return;

    if (!opts.traceStore) {
      return reply.status(503).send({ error: 'Trace store unavailable (redis off)' });
    }

    const { segmentId } = request.params as { segmentId: string };
    const query = request.query as { threadId?: string; turnId?: string };
    const { threadId, turnId } = query;
    if (!threadId || !turnId) {
      return reply.status(400).send({ error: 'threadId and turnId are required' });
    }

    const hasAccess = await requireThreadAccess(opts.threadStore, threadId, userId, reply);
    if (!hasAccess) return;

    const snapshot = await opts.traceStore.getReplaySnapshot(threadId, turnId, segmentId);
    if (!snapshot) {
      return reply.status(404).send({ error: 'Replay snapshot not found' });
    }

    const contentValidation = validateStringField(snapshot.content);
    const sourceKindValidation = validateSourceKind(snapshot.contentSourceKind);
    const templateRefValidation = validateStringField(snapshot.contentSourceRef);
    const templateVarsValidation = validateTemplateVars(snapshot.templateVars);
    const versionValidation = validateVersion(snapshot.version);
    const anchorValidation = validateMessageAnchorId(snapshot.messageAnchorId);
    const surroundingIdsValidation = validateSurroundingMessageIds(snapshot.surroundingMessageIds);

    const guardResult = await fetchGuardEvents(opts.guardRejectionLog, threadId, snapshot.catId, snapshot.timestamp);
    const messagesResult =
      surroundingIdsValidation.gap !== null
        ? { messages: null, gap: surroundingIdsValidation.gap }
        : await fetchSurroundingMessages(opts.messageStore, surroundingIdsValidation.value);

    const response: SegmentReplayResponse = {
      segmentId,
      threadId,
      turnId,
      timestamp: snapshot.timestamp,
      catId: snapshot.catId,
      stage: snapshot.stage,
      pipelineStatus: snapshot.pipelineStatus,
      version: versionValidation.version,
      versionGap: versionValidation.gap,
      content: contentValidation.value,
      contentGap: contentValidation.gap,
      contentSourceKind: sourceKindValidation.value,
      contentSourceKindGap: sourceKindValidation.gap,
      templateRef: templateRefValidation.value,
      templateRefGap: templateRefValidation.gap,
      templateVars: templateVarsValidation.vars,
      templateVarsGap: templateVarsValidation.gap,
      messageAnchorId: anchorValidation.value,
      messageAnchorIdGap: anchorValidation.gap,
      surroundingMessages: messagesResult.messages,
      surroundingMessagesGap: messagesResult.gap,
      guardEvents: guardResult.events,
      guardEventsGap: guardResult.gap,
    };

    return reply.send(response);
  });
};
