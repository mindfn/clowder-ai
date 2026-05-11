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
  category: 'generation' | 'analysis';
  capabilities: string[];
  baseUrl: string;
  models: string[];
  requiredFields: { key: string; label: string; secret?: boolean }[];
}

const PROVIDERS: ProviderDef[] = [
  // ── 视频生成 ──
  {
    id: 'cogvideox',
    displayName: 'CogVideoX (智谱)',
    category: 'generation',
    capabilities: ['text2video', 'image2video'],
    baseUrl: 'https://open.bigmodel.cn',
    models: ['cogvideox-flash'],
    requiredFields: [{ key: 'apiKey', label: 'API Key (open.bigmodel.cn)', secret: true }],
  },
  {
    id: 'kling',
    displayName: '可灵 (Kling AI)',
    category: 'generation',
    capabilities: ['text2video', 'image2video'],
    baseUrl: 'https://api.klingapi.com',
    models: ['kling-v2.6-pro', 'kling-v1.6-pro'],
    requiredFields: [
      { key: 'accessKey', label: 'Access Key' },
      { key: 'secretKey', label: 'Secret Key', secret: true },
    ],
  },
  {
    id: 'jimeng',
    displayName: '即梦 (Jimeng)',
    category: 'generation',
    capabilities: ['text2video', 'image2video', 'text2image'],
    baseUrl: 'https://visual.volcengineapi.com',
    models: ['jimeng_t2v_v30', 'jimeng_i2v_v20', 'jimeng_high_aes_general_v21'],
    requiredFields: [
      { key: 'accessKey', label: 'Access Key (Volcengine)' },
      { key: 'secretKey', label: 'Secret Key (Volcengine)', secret: true },
    ],
  },
  // ── 视频分析 ──
  {
    id: 'zhipu-analysis',
    displayName: '智谱 VLM',
    category: 'analysis',
    capabilities: ['video-understanding'],
    baseUrl: 'https://open.bigmodel.cn',
    models: ['glm-4.1v-thinking-flash'],
    requiredFields: [{ key: 'apiKey', label: 'API Key (open.bigmodel.cn)', secret: true }],
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
        providers: PROVIDERS.map((p) => ({
          ...p,
          bound: false,
          healthStatus: 'unchecked' as const,
          createdAt: 0,
        })),
      };
    }

    const items = [];
    for (const def of PROVIDERS) {
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
    if (!def) {
      reply.status(400);
      return { error: `Unknown provider: ${id}` };
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
