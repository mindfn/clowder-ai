/** F770: runtime log level persisted to user-preferences.json (migrated from LOG_LEVEL env). */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { resolveLogLevel, saveLogLevel } from '../config/user-preferences-store.js';
import { logger, setRuntimeLogLevel } from '../infrastructure/logger.js';
import { resolveOwnerGate } from '../utils/owner-gate.js';
import { resolveHeaderUserId } from '../utils/request-identity.js';

interface LogLevelRoutesOptions {
  projectRoot: string;
}

const putSchema = z.object({
  logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']),
});

export async function configLogLevelRoutes(app: FastifyInstance, opts: LogLevelRoutesOptions): Promise<void> {
  app.get('/api/config/log-level', async () => ({
    ...resolveLogLevel(opts.projectRoot),
    // The level actually in effect right now (pino default 'info' when nothing
    // is stored) — the UI small-print states this current fact.
    effectiveLevel: logger.level,
  }));

  app.put('/api/config/log-level', async (request: FastifyRequest, reply: FastifyReply) => {
    const operator = resolveHeaderUserId(request);
    if (!operator) {
      reply.status(400);
      return { error: 'Identity required (X-Cat-Cafe-User header)' };
    }
    const gateResult = resolveOwnerGate(operator, {
      errorMessage: 'Only the owner can change log level',
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
    const saved = saveLogLevel(opts.projectRoot, parsed.data.logLevel);
    const applied = saved.logLevel !== null && setRuntimeLogLevel(saved.logLevel);
    return { ...saved, effectiveLevel: logger.level, applied };
  });
}
