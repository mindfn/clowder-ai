/**
 * Fail-closed storage guard.
 * Ensures Redis is available unless memory mode is explicitly opted into.
 *
 * Two-layer defense:
 * 1. start-dev.sh exits on Redis failure (unless --memory flag)
 * 2. This guard catches direct `pnpm dev` without Redis
 */

import { parseBoolEnv } from './env-registry.js';

export interface StorageGuardResult {
  mode: 'redis' | 'memory';
}

/**
 * Assert that a valid storage backend is available.
 * Throws if Redis is unavailable and MEMORY_STORE is not enabled.
 */
export function assertStorageReady(redisAvailable: boolean): StorageGuardResult {
  if (redisAvailable) {
    return { mode: 'redis' };
  }

  if (parseBoolEnv(process.env.MEMORY_STORE)) {
    return { mode: 'memory' };
  }

  throw new Error(
    '[api] REDIS_URL not set and MEMORY_STORE not enabled. ' +
      'Start Redis or use --memory flag. ' +
      'Set MEMORY_STORE=true to explicitly allow in-memory storage.',
  );
}
