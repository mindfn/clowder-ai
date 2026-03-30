/**
 * F150: Guide Callback Routes
 * POST /api/callbacks/update-guide-state — update guide session state (forward-only)
 * POST /api/callbacks/start-guide       — start a guide (validates offered→active)
 * POST /api/callbacks/guide-resolve      — resolve user intent to matching guides
 * POST /api/callbacks/guide-control      — control an active guide (next/back/skip/exit)
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { InvocationRegistry } from '../domains/cats/services/agents/invocation/InvocationRegistry.js';
import type { GuideStateV1, GuideStatus, IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import type { SocketManager } from '../infrastructure/websocket/index.js';
import { callbackAuthSchema } from './callback-auth-schema.js';
import { EXPIRED_CREDENTIALS_ERROR } from './callback-errors.js';

// ---------------------------------------------------------------------------
// State machine: valid transitions (forward-only DAG)
// ---------------------------------------------------------------------------
const VALID_TRANSITIONS: Record<GuideStatus, readonly GuideStatus[]> = {
  offered: ['awaiting_choice', 'active', 'cancelled'],
  awaiting_choice: ['active', 'cancelled'],
  active: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
};

function isValidTransition(from: GuideStatus, to: GuideStatus): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

const guideStatusSchema = z.enum(['offered', 'awaiting_choice', 'active', 'completed', 'cancelled']);

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------
const updateGuideStateSchema = callbackAuthSchema.extend({
  threadId: z.string().min(1),
  guideId: z.string().min(1),
  status: guideStatusSchema,
  currentStep: z.number().int().min(0).optional(),
});

const startGuideSchema = callbackAuthSchema.extend({
  guideId: z.string().min(1),
});

const resolveGuideSchema = callbackAuthSchema.extend({
  intent: z.string().min(1),
});

const controlGuideSchema = callbackAuthSchema.extend({
  action: z.enum(['next', 'back', 'skip', 'exit']),
});

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------
export async function registerCallbackGuideRoutes(
  app: FastifyInstance,
  deps: {
    registry: InvocationRegistry;
    threadStore: IThreadStore;
    socketManager: SocketManager;
  },
): Promise<void> {
  const { registry, threadStore, socketManager } = deps;
  const log = app.log;

  // Static ESM import — fail loudly if loader is broken
  const { isValidGuideId, resolveGuideForIntent } = await import(
    '../domains/guides/guide-registry-loader.js'
  );

  // POST /api/callbacks/update-guide-state
  app.post('/api/callbacks/update-guide-state', async (request, reply) => {
    const parsed = updateGuideStateSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parsed.error.issues };
    }

    const { invocationId, callbackToken, threadId, guideId, status, currentStep } = parsed.data;
    const record = registry.verify(invocationId, callbackToken);
    if (!record) {
      reply.status(401);
      return EXPIRED_CREDENTIALS_ERROR;
    }

    if (!registry.isLatest(invocationId)) {
      return { status: 'stale_ignored' };
    }

    // Cross-thread binding check
    if (record.threadId !== threadId) {
      reply.status(403);
      return { error: 'Cross-thread write rejected' };
    }

    const thread = await threadStore.get(threadId);
    if (!thread) {
      reply.status(404);
      return { error: 'Thread not found' };
    }

    if (!isValidGuideId(guideId)) {
      reply.status(400);
      return { error: 'unknown_guide_id', message: `Guide "${guideId}" is not registered` };
    }

    const existing = thread.guideState;

    // First offer — no existing state
    if (!existing) {
      if (status !== 'offered') {
        reply.status(400);
        return { error: `Cannot create guide state with status "${status}" — must start as "offered"` };
      }
      const newState: GuideStateV1 = {
        v: 1,
        guideId,
        status: 'offered',
        offeredAt: Date.now(),
        offeredBy: record.catId ?? undefined,
      };
      await threadStore.updateGuideState(threadId, newState);
      log.info({ guideId, threadId, catId: record.catId }, '[F150] guide state created: offered');
      return { guideState: newState };
    }

    // Guide ID mismatch — reject (one active guide per thread)
    if (existing.guideId !== guideId) {
      // Allow new offer only if previous guide is terminal
      if (existing.status !== 'completed' && existing.status !== 'cancelled') {
        reply.status(409);
        return {
          error: 'guide_conflict',
          message: `Thread has active guide "${existing.guideId}" in status "${existing.status}" — complete or cancel it first`,
        };
      }
      // Previous guide is terminal, allow new offer
      if (status !== 'offered') {
        reply.status(400);
        return { error: `Cannot create new guide state with status "${status}" — must start as "offered"` };
      }
      const newState: GuideStateV1 = {
        v: 1,
        guideId,
        status: 'offered',
        offeredAt: Date.now(),
        offeredBy: record.catId ?? undefined,
      };
      await threadStore.updateGuideState(threadId, newState);
      log.info({ guideId, threadId }, '[F150] guide state replaced (previous was terminal)');
      return { guideState: newState };
    }

    // Same guide, terminal state — allow fresh re-offer
    if ((existing.status === 'completed' || existing.status === 'cancelled') && status === 'offered') {
      const newState: GuideStateV1 = {
        v: 1,
        guideId,
        status: 'offered',
        offeredAt: Date.now(),
        offeredBy: record.catId ?? undefined,
      };
      await threadStore.updateGuideState(threadId, newState);
      log.info({ guideId, threadId }, '[F150] guide re-offered after terminal state');
      return { guideState: newState };
    }

    // Same guide — validate state transition
    if (!isValidTransition(existing.status, status)) {
      reply.status(400);
      return {
        error: `Invalid guide transition: ${existing.status} → ${status}`,
        validTransitions: VALID_TRANSITIONS[existing.status],
      };
    }

    const updated: GuideStateV1 = {
      ...existing,
      status,
      ...(status === 'active' ? { startedAt: Date.now() } : {}),
      ...(status === 'completed' || status === 'cancelled' ? { completedAt: Date.now() } : {}),
      ...(currentStep !== undefined ? { currentStep } : {}),
    };
    await threadStore.updateGuideState(threadId, updated);
    log.info({ guideId, threadId, transition: `${existing.status}→${status}` }, '[F150] guide state updated');
    return { guideState: updated };
  });

  // POST /api/callbacks/start-guide — convenience route (validates offered/awaiting_choice → active)
  app.post('/api/callbacks/start-guide', async (request, reply) => {
    const parsed = startGuideSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request', details: parsed.error.issues };
    }
    const { invocationId, callbackToken, guideId } = parsed.data;
    const record = registry.verify(invocationId, callbackToken);
    if (!record) {
      reply.status(401);
      return EXPIRED_CREDENTIALS_ERROR;
    }
    if (!registry.isLatest(invocationId)) return { status: 'stale_ignored' };
    if (!isValidGuideId(guideId)) {
      reply.status(400);
      return { error: 'unknown_guide_id', message: `Guide "${guideId}" is not registered` };
    }

    // State validation: must be in offered or awaiting_choice
    const thread = await threadStore.get(record.threadId);
    const guideState = thread?.guideState;
    if (!guideState || guideState.guideId !== guideId) {
      reply.status(400);
      return {
        error: 'guide_not_offered',
        message: `Guide "${guideId}" has not been offered in this thread — call update-guide-state first`,
      };
    }
    if (guideState.status !== 'offered' && guideState.status !== 'awaiting_choice') {
      reply.status(400);
      return {
        error: `Cannot start guide in status "${guideState.status}" — must be "offered" or "awaiting_choice"`,
      };
    }

    // Transition to active
    const updated: GuideStateV1 = { ...guideState, status: 'active', startedAt: Date.now() };
    await threadStore.updateGuideState(record.threadId, updated);

    // Emit socket event for frontend guide engine
    socketManager.broadcastToRoom(`thread:${record.threadId}`, 'guide_start', {
      guideId,
      threadId: record.threadId,
      timestamp: Date.now(),
    });
    log.info({ guideId, threadId: record.threadId }, '[F150] guide started (state: active)');
    return { status: 'ok', guideId, guideState: updated };
  });

  // POST /api/callbacks/guide-resolve
  app.post('/api/callbacks/guide-resolve', async (request, reply) => {
    const parsed = resolveGuideSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request', details: parsed.error.issues };
    }
    const { invocationId, callbackToken, intent } = parsed.data;
    const record = registry.verify(invocationId, callbackToken);
    if (!record) {
      reply.status(401);
      return EXPIRED_CREDENTIALS_ERROR;
    }

    const matches = resolveGuideForIntent(intent);
    log.info({ intent, matchCount: matches.length, threadId: record.threadId }, '[F150] guide_resolve');
    return { status: 'ok', matches };
  });

  // POST /api/callbacks/guide-control — validates active state
  app.post('/api/callbacks/guide-control', async (request, reply) => {
    const parsed = controlGuideSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request', details: parsed.error.issues };
    }
    const { invocationId, callbackToken, action } = parsed.data;
    const record = registry.verify(invocationId, callbackToken);
    if (!record) {
      reply.status(401);
      return EXPIRED_CREDENTIALS_ERROR;
    }
    if (!registry.isLatest(invocationId)) return { status: 'stale_ignored' };

    // State validation: must have active guide
    const thread = await threadStore.get(record.threadId);
    const guideState = thread?.guideState;
    if (!guideState || guideState.status !== 'active') {
      reply.status(400);
      return {
        error: 'no_active_guide',
        message: `No active guide in thread — current status: ${guideState?.status ?? 'none'}`,
      };
    }

    // Exit action → cancel guide
    if (action === 'exit') {
      const updated: GuideStateV1 = { ...guideState, status: 'cancelled', completedAt: Date.now() };
      await threadStore.updateGuideState(record.threadId, updated);
    }

    socketManager.broadcastToRoom(`thread:${record.threadId}`, 'guide_control', {
      action,
      guideId: guideState.guideId,
      threadId: record.threadId,
      timestamp: Date.now(),
    });
    log.info({ action, guideId: guideState.guideId, threadId: record.threadId }, '[F150] guide_control');
    return { status: 'ok', action };
  });
}
