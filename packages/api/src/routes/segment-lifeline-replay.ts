/**
 * F257 Console 判据④ — Segment lifeline true-scene replay endpoint.
 *
 * Returns the event-time rendered segment content, template provenance,
 * variable bindings, nearby guard events, and surrounding conversation context
 * for a single (segmentId, threadId, turnId) observation.
 *
 * Auth: session-only (read surface, no mutation).
 */

import type {
  ObservedSegment,
  ReplayProvenanceGap,
  ReplaySurroundingMessage,
  SegmentReplayResponse,
} from '@cat-cafe/shared';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { IMessageStore, StoredMessage } from '../domains/cats/services/stores/ports/MessageStore.js';
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
}

const REPLAY_GUARD_WINDOW_MS = 120_000;
const SURROUNDING_MESSAGE_LIMIT = 20;
const PREVIEW_MAX_LEN = 200;

function requireSession(request: FastifyRequest, reply: FastifyReply): string | null {
  const userId = (request as FastifyRequest & { sessionUserId?: string }).sessionUserId;
  if (!userId) {
    reply.status(401).send({ error: 'Session required' });
    return null;
  }
  return userId;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateTemplateVars(raw: unknown): { vars: Record<string, string> | null; gap: ReplayProvenanceGap | null } {
  if (raw === undefined) return { vars: null, gap: 'legacy-missing' };
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
  if (typeof raw !== 'number' || !Number.isInteger(raw)) return { version: null, gap: 'invalid-present' };
  return { version: raw, gap: null };
}

function validateStringField(raw: unknown): { value: string | null; gap: ReplayProvenanceGap | null } {
  if (raw === undefined) return { value: null, gap: 'legacy-missing' };
  if (raw === null) return { value: null, gap: null };
  if (typeof raw !== 'string') return { value: null, gap: 'invalid-present' };
  return { value: raw, gap: null };
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

function mapSurroundingMessage(msg: StoredMessage): ReplaySurroundingMessage {
  const preview = msg.content?.slice(0, PREVIEW_MAX_LEN) ?? '';
  const ellipsis = msg.content && msg.content.length > PREVIEW_MAX_LEN ? '…' : '';
  return {
    messageId: msg.id,
    role: msg.catId == null ? 'user' : 'assistant',
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
  const events = await log.queryWindow({
    since: timestamp - REPLAY_GUARD_WINDOW_MS,
    until: timestamp + REPLAY_GUARD_WINDOW_MS,
    threadId,
    catId,
    limit: 50,
  });
  return { events: events.map(mapGuardEvent), gap: null };
}

async function fetchSurroundingMessages(
  store: IMessageStore | undefined,
  threadId: string,
): Promise<{ messages: ReplaySurroundingMessage[] | null; gap: ReplayProvenanceGap | null }> {
  if (!store) return { messages: null, gap: 'unavailable' };
  try {
    const messages = await store.getByThread(threadId, SURROUNDING_MESSAGE_LIMIT);
    return { messages: messages.map(mapSurroundingMessage), gap: null };
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

    const detail = await opts.traceStore.getDetail(threadId, turnId);
    if (!detail) {
      return reply.status(404).send({ error: 'Trace detail not found' });
    }

    const segment = detail.segments.find((s: ObservedSegment) => s.segmentId === segmentId);
    if (!segment) {
      return reply.status(404).send({ error: 'Segment observation not found for this turn' });
    }

    const contentValidation = validateStringField(segment.content);
    const templateRefValidation = validateStringField(segment.templateRef);
    const templateVarsValidation = validateTemplateVars(segment.templateVars);
    const versionValidation = validateVersion(segment.version);

    const [guardResult, messagesResult] = await Promise.all([
      fetchGuardEvents(opts.guardRejectionLog, threadId, detail.catId, detail.timestamp),
      fetchSurroundingMessages(opts.messageStore, threadId),
    ]);

    const response: SegmentReplayResponse = {
      segmentId,
      threadId,
      turnId,
      timestamp: detail.timestamp,
      catId: detail.catId,
      stage: segment.stage,
      pipelineStatus: segment.pipelineStatus ?? 'observed',
      version: versionValidation.version,
      versionGap: versionValidation.gap,
      content: contentValidation.value,
      contentGap: contentValidation.gap,
      templateRef: templateRefValidation.value,
      templateRefGap: templateRefValidation.gap,
      templateVars: templateVarsValidation.vars,
      templateVarsGap: templateVarsValidation.gap,
      surroundingMessages: messagesResult.messages,
      surroundingMessagesGap: messagesResult.gap,
      guardEvents: guardResult.events,
      guardEventsGap: guardResult.gap,
    };

    return reply.send(response);
  });
};
