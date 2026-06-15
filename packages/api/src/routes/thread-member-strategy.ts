/**
 * #921: PATCH /api/threads/:id/members/:catId/session-strategy
 *
 * Expose the per-member session strategy (resume / reborn) that was
 * implemented in PR #834 / #836 but lacked an API surface.
 *
 * GET returns the current strategy (undefined = default resume).
 * PATCH sets or clears it.
 */

import { catIdSchema } from '@cat-cafe/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { resolveHeaderUserId } from '../utils/request-identity.js';

const strategySchema = z.object({
  strategy: z.enum(['resume', 'reborn']).nullable(),
});

export interface ThreadMemberStrategyRouteOptions {
  threadStore: {
    get(id: string): { id: string } | null | Promise<{ id: string } | null>;
    updateMemberSessionStrategy(
      threadId: string,
      catId: string,
      strategy: 'resume' | 'reborn' | null,
    ): void | Promise<void>;
    getMemberSessionStrategy?(
      threadId: string,
      catId: string,
      userId: string,
    ): 'resume' | 'reborn' | undefined | Promise<'resume' | 'reborn' | undefined>;
  };
}

export const threadMemberStrategyRoutes: FastifyPluginAsync<ThreadMemberStrategyRouteOptions> = async (app, opts) => {
  const { threadStore } = opts;

  // GET /api/threads/:id/members/:catId/session-strategy
  app.get<{ Params: { id: string; catId: string } }>(
    '/api/threads/:id/members/:catId/session-strategy',
    async (request, reply) => {
      const userId = resolveHeaderUserId(request);
      if (!userId) {
        reply.status(401);
        return { error: 'Identity required' };
      }

      const { id, catId } = request.params;
      const catParsed = catIdSchema().safeParse(catId);
      if (!catParsed.success) {
        reply.status(400);
        return { error: 'Invalid catId' };
      }

      const thread = await threadStore.get(id);
      if (!thread) {
        reply.status(404);
        return { error: 'Thread not found' };
      }

      const current = threadStore.getMemberSessionStrategy
        ? await threadStore.getMemberSessionStrategy(id, catId, userId)
        : undefined;

      return { threadId: id, catId, strategy: current ?? 'resume' };
    },
  );

  // PATCH /api/threads/:id/members/:catId/session-strategy
  app.patch<{ Params: { id: string; catId: string } }>(
    '/api/threads/:id/members/:catId/session-strategy',
    async (request, reply) => {
      const userId = resolveHeaderUserId(request);
      if (!userId) {
        reply.status(401);
        return { error: 'Identity required' };
      }

      const { id, catId } = request.params;
      const catParsed = catIdSchema().safeParse(catId);
      if (!catParsed.success) {
        reply.status(400);
        return { error: 'Invalid catId' };
      }

      const parsed = strategySchema.safeParse(request.body);
      if (!parsed.success) {
        reply.status(400);
        return { error: 'strategy must be "resume", "reborn", or null', details: parsed.error.issues };
      }

      const thread = await threadStore.get(id);
      if (!thread) {
        reply.status(404);
        return { error: 'Thread not found' };
      }

      await threadStore.updateMemberSessionStrategy(id, catId, parsed.data.strategy);

      return { ok: true, threadId: id, catId, strategy: parsed.data.strategy ?? 'resume' };
    },
  );
};
