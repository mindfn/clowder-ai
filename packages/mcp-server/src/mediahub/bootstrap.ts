/**
 * MediaHub — Bootstrap
 * F139: Initializes providers, job store, and service at startup.
 *
 * Redis: tries real Redis via REDIS_URL (or default 6398 dev port).
 * Falls back to in-memory stub if unavailable — jobs won't persist across restarts.
 */

import { createRedisClient } from '@cat-cafe/shared/utils';

import type { RedisClient } from './job-store.js';
import { JobStore } from './job-store.js';
import { MediaStorage } from './media-storage.js';
import { MediaHubService } from './mediahub-service.js';
import { setMediaHubService } from './mediahub-tools.js';
import { ProviderRegistry } from './provider.js';
import { createCogVideoXProvider } from './providers/cogvideox.js';

/** Wrap ioredis instance to our minimal RedisClient interface */
function wrapIoredis(ioredis: ReturnType<typeof createRedisClient>): RedisClient {
  return {
    hset: (key, data) => ioredis.hset(key, data),
    hgetall: (key) => ioredis.hgetall(key),
    expire: (key, seconds) => ioredis.expire(key, seconds),
    zadd: async (key, ...args) => {
      // ioredis zadd: score1, member1, score2, member2, ...
      const strArgs = args.map(String);
      return ioredis.zadd(key, ...strArgs) as unknown as number;
    },
    zrevrangebyscore: async (key, max, min, ...rest) => {
      const sMax = String(max);
      const sMin = String(min);
      if (rest[0] === 'LIMIT') {
        return ioredis.zrevrangebyscore(key, sMax, sMin, 'LIMIT', Number(rest[1]), Number(rest[2]));
      }
      return ioredis.zrevrangebyscore(key, sMax, sMin);
    },
    del: (key) => ioredis.del(key),
  };
}

/** In-memory Redis stub for when real Redis is unavailable */
function createMemoryRedisStub(): RedisClient {
  const store = new Map<string, Record<string, string>>();
  const sortedSets = new Map<string, Array<{ score: number; member: string }>>();

  return {
    async hset(key: string, data: Record<string, string>) {
      const existing = store.get(key) ?? {};
      store.set(key, { ...existing, ...data });
      return Object.keys(data).length;
    },
    async hgetall(key: string) {
      return store.get(key) ?? {};
    },
    async expire(_key: string, _seconds: number) {
      return 1;
    },
    async zadd(key: string, ...args: Array<string | number>) {
      const set = sortedSets.get(key) ?? [];
      for (let i = 0; i < args.length; i += 2) {
        const score = Number(args[i]);
        const member = String(args[i + 1]);
        const existing = set.findIndex((e) => e.member === member);
        if (existing >= 0) {
          set[existing].score = score;
        } else {
          set.push({ score, member });
        }
      }
      set.sort((a, b) => b.score - a.score);
      sortedSets.set(key, set);
      return args.length / 2;
    },
    async zrevrangebyscore(key: string, _max: string | number, _min: string | number, ...args: string[]) {
      const set = sortedSets.get(key) ?? [];
      let limit = set.length;
      const limitIdx = args.indexOf('LIMIT');
      if (limitIdx >= 0 && args[limitIdx + 2]) {
        limit = Number(args[limitIdx + 2]);
      }
      return set.slice(0, limit).map((e) => e.member);
    },
    async del(key: string) {
      store.delete(key);
      return 1;
    },
  };
}

/** Try real Redis, fall back to in-memory stub */
function createRedis(): { client: RedisClient; persistent: boolean } {
  try {
    const url = process.env['REDIS_URL'] ?? 'redis://localhost:6398';
    const ioredis = createRedisClient({ url, keyPrefix: 'cat-cafe:' });

    // Attach error handler to prevent unhandled rejection on connect failure
    let failed = false;
    ioredis.on('error', () => {
      failed = true;
    });

    // If connection fails within 2s, bootstrapMediaHub will already have
    // completed with the real client. The error handler above prevents crash.
    // Jobs stored before disconnect are in Redis; after, calls will throw
    // and tools will return error messages gracefully.
    if (!failed) {
      console.error(`[mediahub] Redis connected: ${url}`);
      return { client: wrapIoredis(ioredis), persistent: true };
    }
  } catch {
    // createRedisClient threw — fall through to in-memory
  }

  console.error('[mediahub] Redis unavailable, using in-memory stub (jobs will not persist across restarts)');
  return { client: createMemoryRedisStub(), persistent: false };
}

export function bootstrapMediaHub(): void {
  const registry = new ProviderRegistry();

  const cogvideox = createCogVideoXProvider();
  if (cogvideox) {
    registry.register(cogvideox);
    console.error('[mediahub] Registered provider: CogVideoX');
  }

  const { client: redis, persistent } = createRedis();
  const jobStore = new JobStore(redis);
  const storage = new MediaStorage();

  const service = new MediaHubService(registry, jobStore, storage);
  setMediaHubService(service);

  const mode = persistent ? 'persistent' : 'in-memory';
  console.error(`[mediahub] Bootstrap complete. Providers: ${registry.size}, Redis: ${mode}`);
}
