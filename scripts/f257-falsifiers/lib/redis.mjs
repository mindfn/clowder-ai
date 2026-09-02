// Read-only Redis helpers. Nothing here issues a write command.
import { createRequire } from 'node:module';
import { join } from 'node:path';
import process from 'node:process';

async function loadIoredis() {
  try {
    return (await import('ioredis')).default;
  } catch {
    // Fresh worktrees carry no node_modules: resolve from the cwd project root instead.
    const resolved = createRequire(join(process.cwd(), 'package.json')).resolve('ioredis');
    return (await import(resolved)).default;
  }
}

export async function openRedis(url) {
  const Redis = await loadIoredis();
  const redis = new Redis(url, { maxRetriesPerRequest: 3, lazyConnect: true });
  await redis.connect();
  return redis;
}

export function escapeRedisGlob(value) {
  return value.replaceAll('\\', '\\\\').replaceAll('*', '\\*').replaceAll('?', '\\?').replaceAll('[', '\\[');
}

export async function scanKeys(redis, pattern) {
  const keys = new Set();
  let cursor = '0';
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
    cursor = String(next);
    for (const key of batch) keys.add(key);
  } while (cursor !== '0');
  return [...keys].sort();
}

export async function memoryUsageBytes(redis, key) {
  const usage = await redis.call('MEMORY', 'USAGE', key);
  return typeof usage === 'number' ? usage : null;
}

export async function readJsonKey(redis, key) {
  const raw = await redis.get(key);
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return { __invalidJson: true };
  }
}
