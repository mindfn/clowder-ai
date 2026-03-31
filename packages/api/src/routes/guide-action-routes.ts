/**
 * F150: Frontend-Facing Guide Action Routes
 *
 * These endpoints are called directly by the frontend InteractiveBlock
 * when a user clicks a guide option with an `action` field.
 * They use userId-based auth (X-Cat-Cafe-User header), NOT MCP callback auth.
 *
 * POST /api/guide-actions/start   — start a guide (offered/awaiting_choice → active)
 * POST /api/guide-actions/cancel  — cancel a guide (offered/awaiting_choice → cancelled)
 */
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { GuideStateV1, IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import { loadGuideFlow } from '../domains/guides/guide-registry-loader.js';
import type { SocketManager } from '../infrastructure/websocket/index.js';
import { resolveHeaderUserId } from '../utils/request-identity.js';

export interface GuideActionRoutesOptions {
  threadStore: IThreadStore;
  socketManager: SocketManager;
}

const startSchema = z.object({
  threadId: z.string().min(1),
  guideId: z.string().min(1),
});

const cancelSchema = z.object({
  threadId: z.string().min(1),
  guideId: z.string().min(1),
});

export const guideActionRoutes: FastifyPluginAsync<GuideActionRoutesOptions> = async (app, opts) => {
  const { threadStore, socketManager } = opts;
  const log = app.log;

  // POST /api/guide-actions/start — frontend clicks "开始引导"
  app.post('/api/guide-actions/start', async (request, reply) => {
    const userId = resolveHeaderUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required (X-Cat-Cafe-User header)' };
    }

    const parsed = startSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request', details: parsed.error.issues };
    }

    const { threadId, guideId } = parsed.data;
    const thread = await threadStore.get(threadId);
    if (!thread) {
      reply.status(404);
      return { error: 'Thread not found' };
    }

    // Default thread (createdBy='system') is public — any authenticated user can access
    if (thread.createdBy !== 'system' && thread.createdBy !== userId) {
      reply.status(403);
      return { error: 'Thread access denied' };
    }

    const gs = thread.guideState;
    if (!gs || gs.guideId !== guideId) {
      reply.status(400);
      return { error: 'guide_not_offered', message: `Guide "${guideId}" not offered in this thread` };
    }
    if (gs.status !== 'offered' && gs.status !== 'awaiting_choice') {
      reply.status(400);
      return { error: `Cannot start guide in status "${gs.status}"` };
    }

    // P1 fix: validate flow is loadable before committing state transition
    try {
      loadGuideFlow(guideId);
    } catch (err) {
      log.warn({ guideId, threadId, err }, '[F150] start rejected — flow not loadable');
      reply.status(400);
      return { error: 'guide_flow_invalid', message: (err as Error).message };
    }

    const updated: GuideStateV1 = { ...gs, status: 'active', startedAt: Date.now() };
    await threadStore.updateGuideState(threadId, updated);

    socketManager.broadcastToRoom(`thread:${threadId}`, 'guide_start', {
      guideId,
      threadId,
      timestamp: Date.now(),
    });
    log.info({ guideId, threadId, userId }, '[F150] guide started via frontend action');
    return { status: 'ok', guideId, guideState: updated };
  });

  // GET /api/guide-flows/:guideId — serve flow definition at runtime
  app.get<{ Params: { guideId: string } }>('/api/guide-flows/:guideId', async (request, reply) => {
    const { guideId } = request.params;
    try {
      const flow = loadGuideFlow(guideId);
      return flow;
    } catch (err) {
      log.warn({ guideId, err }, '[F150] Failed to load guide flow');
      reply.status(404);
      return { error: 'guide_not_found', message: (err as Error).message };
    }
  });

  // POST /api/guide-actions/cancel — frontend clicks "暂不需要"
  app.post('/api/guide-actions/cancel', async (request, reply) => {
    const userId = resolveHeaderUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required (X-Cat-Cafe-User header)' };
    }

    const parsed = cancelSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request', details: parsed.error.issues };
    }

    const { threadId, guideId } = parsed.data;
    const thread = await threadStore.get(threadId);
    if (!thread) {
      reply.status(404);
      return { error: 'Thread not found' };
    }

    // Default thread (createdBy='system') is public — any authenticated user can access
    if (thread.createdBy !== 'system' && thread.createdBy !== userId) {
      reply.status(403);
      return { error: 'Thread access denied' };
    }

    const gs = thread.guideState;
    if (!gs || gs.guideId !== guideId) {
      reply.status(400);
      return { error: 'guide_not_offered', message: `Guide "${guideId}" not offered in this thread` };
    }
    if (gs.status === 'completed' || gs.status === 'cancelled') {
      return { status: 'ok', guideState: gs };
    }

    const updated: GuideStateV1 = { ...gs, status: 'cancelled', completedAt: Date.now() };
    await threadStore.updateGuideState(threadId, updated);
    log.info({ guideId, threadId, userId }, '[F150] guide cancelled via frontend action');
    return { status: 'ok', guideState: updated };
  });
};
