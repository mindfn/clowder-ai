/**
 * MediaHub — Bootstrap
 * F139: Initializes providers, job store, and service at startup.
 *
 * Redis connection is lazy — if REDIS_URL is not set or Redis is unavailable,
 * MediaHub tools will return helpful error messages instead of crashing the MCP server.
 */

import type { RedisClient } from './job-store.js';
import { JobStore } from './job-store.js';
import { MediaStorage } from './media-storage.js';
import { MediaHubService } from './mediahub-service.js';
import { setMediaHubService } from './mediahub-tools.js';
import { ProviderRegistry } from './provider.js';
import { createCogVideoXProvider } from './providers/cogvideox.js';

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
      return 1; // no-op for in-memory
    },
    async zadd(key: string, ...args: Array<string | number>) {
      const set = sortedSets.get(key) ?? [];
      // args come as score, member pairs
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

export function bootstrapMediaHub(): void {
  const registry = new ProviderRegistry();

  // Register available providers
  const cogvideox = createCogVideoXProvider();
  if (cogvideox) {
    registry.register(cogvideox);
    console.error('[mediahub] Registered provider: CogVideoX');
  }

  // Use in-memory Redis stub (real Redis integration in Phase B)
  const redis = createMemoryRedisStub();
  const jobStore = new JobStore(redis);
  const storage = new MediaStorage();

  const service = new MediaHubService(registry, jobStore, storage);
  setMediaHubService(service);

  console.error(`[mediahub] Bootstrap complete. Providers: ${registry.size}`);
}
