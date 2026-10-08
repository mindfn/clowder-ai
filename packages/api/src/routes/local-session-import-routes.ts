import { catRegistry } from '@cat-cafe/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ISessionChainStore } from '../domains/cats/services/stores/ports/SessionChainStore.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import type { LocalSessionList, LocalSessionMetadata } from '../domains/cats/services/types.js';
import { canAccessThread } from '../domains/guides/guide-state-access.js';
import { resolveOwnerGate } from '../utils/owner-gate.js';
import { resolveUserId } from '../utils/request-identity.js';
import { registerLocalSessionListRoute } from './local-session-list-routes.js';

export interface LocalSessionImportOptions {
  threadStore: IThreadStore;
  sessionChainStore: ISessionChainStore;
  inspectLocalSession?: (catId: string, sessionId: string) => Promise<LocalSessionMetadata>;
  listLocalSessions?: (catId: string, limit: number) => Promise<LocalSessionList>;
}

export async function localSessionConflict(
  options: LocalSessionImportOptions,
  sessionId: string,
  userId: string,
  targetThreadId?: string,
) {
  const claimed = await options.sessionChainStore.getByCliSessionId(sessionId);
  if (!claimed || (claimed.threadId === targetThreadId && claimed.userId === userId)) return null;
  const thread = await options.threadStore.get(claimed.threadId);
  return {
    error: 'This session is already connected to a conversation',
    code: 'SESSION_ALREADY_BOUND',
    ...(thread && !thread.deletedAt && canAccessThread(thread, userId)
      ? { boundThread: { id: thread.id, title: thread.title } }
      : {}),
  };
}

export function localSessionFailure(error: unknown): { code: string; error: string } {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  return code === 'SESSION_ACTIVE_WRITER'
    ? { code, error: 'This session is running in its original tool. Close it there, then check again.' }
    : {
        code: 'SESSION_RESUME_FAILED',
        error: 'The original session could not be resumed. Check the ID and try again.',
      };
}

export function registerLocalSessionImportRoutes(app: FastifyInstance, options: LocalSessionImportOptions): void {
  registerLocalSessionListRoute(app, options);
  app.get<{ Params: { catId: string; sessionId: string } }>(
    '/api/local-sessions/:catId/:sessionId',
    async (request, reply) => {
      const userId = resolveUserId(request, { defaultUserId: 'default-user' });
      if (!userId) return reply.status(401).send({ error: 'Identity required' });
      const ownerError = resolveOwnerGate(userId);
      if (ownerError)
        return reply.status(ownerError.status).send({ code: 'SESSION_OWNER_REQUIRED', error: ownerError.error });
      const { catId, sessionId } = request.params;
      const cat = catRegistry.tryGet(catId);
      if (
        !cat ||
        catId === 'gpt-pro' ||
        cat.config.provider === 'openai-chatgpt-pro' ||
        !cat.config.cli ||
        !['openai', 'anthropic'].includes(cat.config.clientId) ||
        !z.string().uuid().safeParse(sessionId).success
      ) {
        return reply.status(400).send({ error: 'Choose a Claude Code or Codex member and a valid session ID' });
      }
      const conflict = await localSessionConflict(options, sessionId, userId);
      if (conflict) return reply.status(409).send(conflict);
      if (!options.inspectLocalSession) return reply.status(503).send({ error: 'Session inspection is unavailable' });
      try {
        return { session: await options.inspectLocalSession(catId, sessionId) };
      } catch (error) {
        return reply.status(409).send(localSessionFailure(error));
      }
    },
  );
}
