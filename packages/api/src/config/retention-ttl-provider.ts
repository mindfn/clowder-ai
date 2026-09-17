/**
 * F770: runtime retention TTL provider.
 *
 * Stores evaluate their TTL per write through this module. Effective values are
 * PUSHED here at startup and on every PUT /api/config/retention; reads hit only
 * this in-memory map plus (when a category was never pushed) the legacy
 * process.env fallback — zero file IO on the hot write path.
 *
 * Fail direction: pushed value → legacy env value → store default (persistent).
 * Unlike theme/log-level there is NO env→JSON migration: six env vars lossily
 * compress into five categories, so env stays a read-only fallback until the
 * owner picks a preset.
 */

import type { RetentionCategory } from '@cat-cafe/shared';
import { RETENTION_CATEGORY_VALUES } from '@cat-cafe/shared';
import { createModuleLogger } from '../infrastructure/logger.js';

const log = createModuleLogger('retention-ttl-provider');

export const RETENTION_ENV_BY_CATEGORY: Record<RetentionCategory, string> = {
  message: 'MESSAGE_TTL_SECONDS',
  thread: 'THREAD_TTL_SECONDS',
  task: 'TASK_TTL_SECONDS',
  summary: 'SUMMARY_TTL_SECONDS',
  backlog: 'BACKLOG_TTL_SECONDS',
};

/** In-memory effective values. A pushed null means "pushed as persistent" (distinct from never-pushed). */
const pushedTtlSeconds = new Map<RetentionCategory, number | null>();

const warnedInvalidEnv = new Set<string>();

/**
 * Parse a legacy env TTL value. Mirrors the pre-#770 factory behavior:
 * missing/empty/invalid/<=0 → null (persistent default), otherwise truncated
 * positive seconds.
 */
export function parseEnvTtlSeconds(raw: string | undefined): number | null {
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    if (!warnedInvalidEnv.has(raw)) {
      warnedInvalidEnv.add(raw);
      log.warn({ raw }, 'Invalid legacy TTL env value, using persistent default');
    }
    return null;
  }
  return Math.floor(parsed);
}

/** Effective TTL for new writes right now. null = persistent. Zero IO when pushed. */
export function getRetentionTtlSeconds(category: RetentionCategory): number | null {
  if (pushedTtlSeconds.has(category)) return pushedTtlSeconds.get(category) ?? null;
  return parseEnvTtlSeconds(process.env[RETENTION_ENV_BY_CATEGORY[category]]);
}

export function pushRetentionTtlSeconds(category: RetentionCategory, seconds: number | null): void {
  pushedTtlSeconds.set(
    category,
    seconds !== null && Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : null,
  );
}

export function pushRetentionTtlSecondsAll(entries: Partial<Record<RetentionCategory, number | null>>): void {
  for (const category of RETENTION_CATEGORY_VALUES) {
    if (category in entries) pushRetentionTtlSeconds(category, entries[category] ?? null);
  }
}

export function resetRetentionTtlForTests(): void {
  pushedTtlSeconds.clear();
  warnedInvalidEnv.clear();
}
