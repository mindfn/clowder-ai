/**
 * MediaHub — Console API for provider account management.
 * F139: Shares Redis key format with MCP AccountManager (AES-256-GCM encryption).
 */

import { createCipheriv, randomBytes } from 'node:crypto';
import type { RedisClient } from '@cat-cafe/shared/utils';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { resolveUserId } from '../utils/request-identity.js';

const CRED_PREFIX = 'mediahub:cred:';
const CRED_INDEX = 'mediahub:creds';
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 16;

interface ProviderDef {
  id: string;
  displayName: string;
  capabilities: string[];
  requiredFields: { key: string; label: string; secret?: boolean }[];
  envHint?: string;
}

const PROVIDERS: ProviderDef[] = [
  {
    id: 'cogvideox',
    displayName: 'CogVideoX',
    capabilities: ['text2video'],
    requiredFields: [],
    envHint: 'COGVIDEO_API_KEY (env var, no binding needed)',
  },
  {
    id: 'kling',
    displayName: '可灵 (Kling AI)',
    capabilities: ['text2video', 'image2video'],
    requiredFields: [
      { key: 'accessKey', label: 'Access Key' },
      { key: 'secretKey', label: 'Secret Key', secret: true },
    ],
  },
  {
    id: 'jimeng',
    displayName: '即梦 (Jimeng)',
    capabilities: ['text2video', 'image2video', 'text2image'],
    requiredFields: [
      { key: 'accessKey', label: 'Access Key (Volcengine)' },
      { key: 'secretKey', label: 'Secret Key (Volcengine)', secret: true },
    ],
  },
];

// ── Encryption (mirrors MCP AccountManager) ──

function encrypt(plaintext: string, key: Buffer): { encrypted: string; iv: string; authTag: string } {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    encrypted: enc.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
  };
}

// ── Route ──

export interface MediaHubAccountsRoutesOptions {
  redis?: RedisClient;
}

const bindSchema = z.object({
  credentials: z.record(z.string().min(1)),
});

export const mediahubAccountsRoutes: FastifyPluginAsync<MediaHubAccountsRoutesOptions> = async (app, opts) => {
  const { redis } = opts;

  const credKeyB64 = process.env['MEDIAHUB_CREDENTIAL_KEY'];
  const credKey = credKeyB64 ? Buffer.from(credKeyB64, 'base64') : undefined;
  const enabled = !!(redis && credKey && credKey.length === 32);

  // GET /api/mediahub/providers — list all providers with bound status
  app.get('/api/mediahub/providers', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required (X-Cat-Cafe-User header or userId query)' };
    }
    if (!enabled || !redis) {
      return {
        enabled: false,
        hint: !redis ? 'Redis not connected' : 'MEDIAHUB_CREDENTIAL_KEY not set (base64 32 bytes)',
        providers: PROVIDERS.map((p) => ({ ...p, bound: false, healthStatus: 'unchecked' as const, createdAt: 0 })),
      };
    }

    const items = [];
    for (const def of PROVIDERS) {
      if (def.requiredFields.length === 0) {
        // Env-only provider (e.g. CogVideoX)
        const envOk = def.id === 'cogvideox' && !!process.env['COGVIDEO_API_KEY'];
        items.push({ ...def, bound: envOk, healthStatus: envOk ? 'healthy' : 'unchecked', createdAt: 0 });
        continue;
      }
      const hash = await redis.hgetall(CRED_PREFIX + def.id);
      const bound = !!hash['providerId'];
      items.push({
        ...def,
        bound,
        healthStatus: (hash['lastHealthStatus'] ?? 'unchecked') as string,
        createdAt: Number(hash['createdAt'] ?? 0),
      });
    }
    return { enabled: true, providers: items };
  });

  // POST /api/mediahub/providers/:id/bind — bind credentials
  app.post<{ Params: { id: string } }>('/api/mediahub/providers/:id/bind', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required (X-Cat-Cafe-User header or userId query)' };
    }
    if (!enabled || !redis || !credKey) {
      reply.status(503);
      return { error: 'MediaHub account management not enabled' };
    }

    const { id } = request.params;
    const def = PROVIDERS.find((p) => p.id === id);
    if (!def || def.requiredFields.length === 0) {
      reply.status(400);
      return { error: `Unknown or env-only provider: ${id}` };
    }

    const parsed = bindSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid body', details: parsed.error.issues };
    }

    const { credentials } = parsed.data;
    const missing = def.requiredFields.filter((f) => !credentials[f.key]).map((f) => f.key);
    if (missing.length > 0) {
      reply.status(400);
      return { error: `Missing required fields: ${missing.join(', ')}` };
    }

    const { encrypted, iv, authTag } = encrypt(JSON.stringify(credentials), credKey);
    const now = Date.now();
    await redis.hset(CRED_PREFIX + id, {
      providerId: id,
      credentialType: 'api_key',
      encryptedData: encrypted,
      iv,
      authTag,
      createdAt: String(now),
      lastHealthStatus: 'unchecked',
      lastHealthAt: '0',
    });
    await redis.zadd(CRED_INDEX, now, id);

    return { ok: true, providerId: id };
  });

  // DELETE /api/mediahub/providers/:id — unbind
  app.delete<{ Params: { id: string } }>('/api/mediahub/providers/:id', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required (X-Cat-Cafe-User header or userId query)' };
    }
    if (!enabled || !redis) {
      reply.status(503);
      return { error: 'MediaHub account management not enabled' };
    }

    const { id } = request.params;
    const hash = await redis.hgetall(CRED_PREFIX + id);
    if (!hash['providerId']) {
      reply.status(404);
      return { error: `Provider ${id} not bound` };
    }

    await redis.del(CRED_PREFIX + id);
    await redis.zrem(CRED_INDEX, id);
    return { ok: true, providerId: id };
  });
};
