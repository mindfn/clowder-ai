import { catRegistry } from '@cat-cafe/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { canAccessThread } from '../domains/guides/guide-state-access.js';
import { resolveOwnerGate } from '../utils/owner-gate.js';
import { resolveUserId } from '../utils/request-identity.js';
import type { LocalSessionImportOptions } from './local-session-import-routes.js';

const querySchema = z.object({ limit: z.coerce.number().int().min(1).max(20).default(20) }).strict();
const rowSchema = z.object({
  sessionId: z.string().uuid(),
  clientId: z.enum(['openai', 'anthropic']),
  projectPath: z.string().startsWith('/'),
  firstPrompt: z.string().max(500),
  lastActivityAt: z.number().finite().nonnegative(),
  turnCount: z.number().int().nonnegative().nullable(),
  recentPrompt: z.string().max(500).optional(),
});

export function registerLocalSessionListRoute(app: FastifyInstance, options: LocalSessionImportOptions): void {
  app.get<{ Params: { catId: string } }>('/api/local-sessions/:catId', async (request, reply) => {
    const userId = resolveUserId(request, { defaultUserId: 'default-user' });
    if (!userId) return reply.status(401).send({ error: 'Identity required' });
    const ownerError = resolveOwnerGate(userId);
    if (ownerError)
      return reply.status(ownerError.status).send({ code: 'SESSION_OWNER_REQUIRED', error: ownerError.error });
    const cat = catRegistry.tryGet(request.params.catId);
    const query = querySchema.safeParse(request.query);
    if (
      !query.success ||
      !cat?.config.cli ||
      request.params.catId === 'gpt-pro' ||
      cat.config.provider === 'openai-chatgpt-pro' ||
      !['anthropic', 'openai'].includes(cat.config.clientId)
    )
      return reply.status(400).send({ error: 'Choose a local Claude Code or Codex member; limit must be 1–20' });
    if (!options.listLocalSessions) return reply.status(503).send({ error: 'Recent session index unavailable' });
    try {
      const listing = await options.listLocalSessions(request.params.catId, query.data.limit);
      const sessions = listing.sessions
        .slice(0, query.data.limit)
        .flatMap((raw) => {
          const parsed = rowSchema.safeParse(raw);
          return parsed.success && parsed.data.clientId === cat.config.clientId ? [parsed.data] : [];
        })
        .sort((a, b) => b.lastActivityAt - a.lastActivityAt);
      const claims = await options.sessionChainStore.getCliSessionBindings(sessions.map((s) => s.sessionId));
      const threads = new Map(
        await Promise.all(
          [...new Set([...claims.values()].map((c) => c.threadId))].map(
            async (id) => [id, await options.threadStore.get(id)] as const,
          ),
        ),
      );
      return {
        limited: listing.limited || listing.sessions.length > query.data.limit,
        sessions: sessions.map((session) => {
          const claim = claims.get(session.sessionId);
          const thread = claim ? threads.get(claim.threadId) : undefined;
          return {
            ...session,
            alreadyBound: Boolean(claim),
            ...(thread && !thread.deletedAt && canAccessThread(thread, userId)
              ? { boundThread: { id: thread.id, title: thread.title } }
              : {}),
          };
        }),
      };
    } catch {
      return reply.status(503).send({
        code: 'SESSION_INDEX_UNAVAILABLE',
        error: 'Recent sessions unavailable. Paste the session ID instead.',
      });
    }
  });
}
