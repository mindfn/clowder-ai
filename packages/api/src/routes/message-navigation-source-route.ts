import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { MessageSearchAccessError, type MessageSearchService } from '../domains/memory/MessageSearchService.js';
import { resolveDirectLocalAuthorizationUserId } from '../utils/request-identity.js';

const sourceSchema = z
  .object({
    threadId: z.string().min(1).max(256),
    messageId: z.string().min(1).max(256).optional(),
    contentRevision: z.string().min(1).max(128).optional(),
  })
  .refine((input) => !input.contentRevision || !!input.messageId);

export function registerMessageNavigationSourceRoute(app: FastifyInstance, service?: MessageSearchService) {
  app.get('/api/evidence/navigation-source', async (request, reply) => {
    const parsed = sourceSchema.safeParse(request.query);
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid source coordinates' });
    const userId = resolveDirectLocalAuthorizationUserId(request);
    if (!userId) return reply.status(401).send({ error: 'Source identity required' });
    if (!service) return reply.status(503).send({ error: 'Source verification unavailable' });
    try {
      const result = await service.resolveNavigationReference(parsed.data, { userId, viewer: { type: 'user' } });
      return result ?? reply.status(404).send({ error: 'Source unavailable' });
    } catch (error) {
      if (error instanceof MessageSearchAccessError)
        return reply.status(403).send({ error: 'Source is not accessible' });
      request.log.warn({ err: error }, 'Source verification unavailable');
      return reply.status(503).send({ error: 'Source verification unavailable' });
    }
  });
}
