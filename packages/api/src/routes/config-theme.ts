/** F770: theme config persisted to user-preferences.json (migrated from THEME_CONFIG env). */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { resolveThemeConfig, saveThemeConfig } from '../config/user-preferences-store.js';
import { resolveOwnerGate } from '../utils/owner-gate.js';
import { resolveHeaderUserId } from '../utils/request-identity.js';

interface ThemeConfigRoutesOptions {
  projectRoot: string;
}

const putSchema = z.object({ themeConfig: z.string().min(1) });

export async function configThemeRoutes(app: FastifyInstance, opts: ThemeConfigRoutesOptions): Promise<void> {
  app.get('/api/config/theme', async () => resolveThemeConfig(opts.projectRoot));

  app.put('/api/config/theme', async (request: FastifyRequest, reply: FastifyReply) => {
    const operator = resolveHeaderUserId(request);
    if (!operator) {
      reply.status(400);
      return { error: 'Identity required (X-Cat-Cafe-User header)' };
    }
    const gateResult = resolveOwnerGate(operator, {
      errorMessage: 'Only the owner can change theme config',
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
    return saveThemeConfig(opts.projectRoot, parsed.data.themeConfig);
  });
}
