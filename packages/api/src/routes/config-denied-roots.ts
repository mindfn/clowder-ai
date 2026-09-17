/** F770: custom project-root denylist persisted to user-preferences.json (migrated from PROJECT_DENIED_ROOTS env). */

import { isAbsolute } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { resolveDeniedRoots, saveDeniedRoots } from '../config/user-preferences-store.js';
import { resolveOwnerGate } from '../utils/owner-gate.js';
import { resolveHeaderUserId } from '../utils/request-identity.js';

interface DeniedRootsRoutesOptions {
  projectRoot: string;
}

const putSchema = z.object({
  deniedRoots: z.array(z.string()),
});

export async function configDeniedRootsRoutes(app: FastifyInstance, opts: DeniedRootsRoutesOptions): Promise<void> {
  app.get('/api/config/denied-roots', async () => ({
    ...resolveDeniedRoots(opts.projectRoot),
    // Platform defaults are always enforced on top of the custom list; the UI
    // small-print states this current fact.
    platformDefaults: true,
  }));

  app.put('/api/config/denied-roots', async (request: FastifyRequest, reply: FastifyReply) => {
    const operator = resolveHeaderUserId(request);
    if (!operator) {
      reply.status(400);
      return { error: 'Identity required (X-Cat-Cafe-User header)' };
    }
    const gateResult = resolveOwnerGate(operator, {
      errorMessage: 'Only the owner can change denied roots',
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
    for (const [index, entry] of parsed.data.deniedRoots.entries()) {
      const trimmed = entry.trim();
      if (trimmed.length === 0) continue; // sanitize drops empties; a blank list row must not 400 the save
      if (!isAbsolute(trimmed)) {
        reply.status(400);
        return { error: `deniedRoots[${index}] must be an absolute path` };
      }
    }
    return saveDeniedRoots(opts.projectRoot, parsed.data.deniedRoots);
  });
}
