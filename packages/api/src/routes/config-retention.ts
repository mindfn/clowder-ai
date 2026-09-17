/** F770: data-retention presets persisted to user-preferences.json (no env migration; legacy env is read-only fallback). */

import type { RetentionCategory } from '@cat-cafe/shared';
import { RETENTION_CATEGORY_VALUES } from '@cat-cafe/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { resolveRetentionConfig, saveRetentionConfig } from '../config/user-preferences-store.js';
import { DRAFT_TTL_SECONDS } from '../domains/cats/services/stores/redis/RedisDraftStore.js';
import { resolveOwnerGate } from '../utils/owner-gate.js';
import { resolveHeaderUserId } from '../utils/request-identity.js';

interface RetentionRoutesOptions {
  projectRoot: string;
}

const secondsSchema = z.number().int().min(0).max(2147483647); // 0 = keep forever

const putSchema = z.object({
  message: secondsSchema.optional(),
  thread: secondsSchema.optional(),
  task: secondsSchema.optional(),
  summary: secondsSchema.optional(),
  backlog: secondsSchema.optional(),
});

export async function configRetentionRoutes(app: FastifyInstance, opts: RetentionRoutesOptions): Promise<void> {
  app.get('/api/config/retention', async () => ({
    ...resolveRetentionConfig(opts.projectRoot),
    // Drafts are an auto-save functional constant, not a retention preset — the
    // UI small-print states this current fact instead of offering a control.
    draftTtlSeconds: DRAFT_TTL_SECONDS,
  }));

  app.put('/api/config/retention', async (request: FastifyRequest, reply: FastifyReply) => {
    const operator = resolveHeaderUserId(request);
    if (!operator) {
      reply.status(400);
      return { error: 'Identity required (X-Cat-Cafe-User header)' };
    }
    const gateResult = resolveOwnerGate(operator, {
      errorMessage: 'Only the owner can change retention settings',
    });
    if (gateResult) {
      reply.status(gateResult.status);
      return { error: gateResult.error };
    }
    const parsed = putSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request', details: parsed.error.issues };
    }
    const saved = saveRetentionConfig(opts.projectRoot, parsed.data);
    // The provider was pushed inside saveRetentionConfig — this is the same-process
    // no-restart guarantee the route-level test asserts.
    const applied: Record<RetentionCategory, number | null> = {
      message: null,
      thread: null,
      task: null,
      summary: null,
      backlog: null,
    };
    for (const category of RETENTION_CATEGORY_VALUES) {
      if (category in parsed.data) {
        applied[category] = saved.config[category] === 0 ? null : saved.config[category];
      }
    }
    return { ...saved, applied, draftTtlSeconds: DRAFT_TTL_SECONDS };
  });
}
