import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  ExternalReviewTransferError,
  type ExternalReviewTransferService,
} from '../domains/community/external-review/ExternalReviewTransferService.js';
import { requireCallbackAuth } from './callback-auth-prehandler.js';

const schema = z
  .object({
    repoFullName: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
    prNumber: z.number().int().positive(),
    expectedAssignmentRevision: z.number().int().nonnegative(),
    proposalId: z.string().min(1).max(200).optional(),
  })
  .strict();

export function registerCallbackExternalReviewTransferRoute(
  app: FastifyInstance,
  service?: Pick<ExternalReviewTransferService, 'transfer'>,
): void {
  app.post('/api/callbacks/transfer-external-review', async (request, reply) => {
    const record = requireCallbackAuth(request, reply);
    if (!record) return;
    if (!record.invocationId) return reply.status(403).send({ error: 'Invocation-bound principal required' });
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid request body', details: parsed.error.issues });
    if (!service) return reply.status(503).send({ error: 'External review transfer producer unavailable' });
    try {
      return await service.transfer({
        ...parsed.data,
        principal: {
          catId: record.catId,
          threadId: record.threadId,
          userId: record.userId,
          invocationId: record.invocationId,
        },
      });
    } catch (error) {
      if (error instanceof ExternalReviewTransferError)
        return reply.status(error.status).send({ error: error.message, code: error.code });
      throw error;
    }
  });
}
