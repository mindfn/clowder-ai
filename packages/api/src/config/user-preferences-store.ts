/**
 * Shared file-backed owner preference store.
 *
 * All feature-specific preference writers update through this module so one
 * setting cannot clobber another. Writes are crash-safe temp+rename and no-TTL.
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, delimiter, dirname, resolve } from 'node:path';
import type {
  MessageDispositionPreferenceSnapshot,
  MessageDispositionPreferences,
  MessageWorkDisposition,
  RetentionCategory,
  RetentionConfigPreferences,
  RetentionConfigResolution,
  UserPreferences,
} from '@cat-cafe/shared';
import { RETENTION_CATEGORY_VALUES } from '@cat-cafe/shared';
import { parseEnvTtlSeconds, pushRetentionTtlSecondsAll, RETENTION_ENV_BY_CATEGORY } from './retention-ttl-provider.js';

export const MESSAGE_DISPOSITION_PRODUCT_DEFAULT: MessageWorkDisposition = 'next_work';

function preferencesPath(projectRoot: string): string {
  return resolve(projectRoot, '.cat-cafe', 'user-preferences.json');
}

export function readUserPreferences(projectRoot: string): UserPreferences {
  const path = preferencesPath(projectRoot);
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    return typeof parsed === 'object' && parsed !== null ? (parsed as UserPreferences) : {};
  } catch {
    return {};
  }
}

export function updateUserPreferences(
  projectRoot: string,
  update: (current: UserPreferences) => UserPreferences,
): UserPreferences {
  // The single API owner cannot yield between read and atomic rename, so same-process
  // writers cannot interleave. Cross-process writers are outside runtime ownership.
  const directory = resolve(projectRoot, '.cat-cafe');
  const path = preferencesPath(projectRoot);
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  mkdirSync(directory, { recursive: true });
  const next = update(readUserPreferences(projectRoot));
  try {
    writeFileSync(tempPath, `${JSON.stringify(next, null, 2)}\n`, 'utf-8');
    renameSync(tempPath, path);
  } finally {
    if (existsSync(tempPath)) unlinkSync(tempPath);
  }
  return next;
}

function isDisposition(value: unknown): value is MessageWorkDisposition {
  return value === 'continue_current' || value === 'next_work';
}

function sanitizeDispositionPreferences(value: unknown): MessageDispositionPreferences {
  if (typeof value !== 'object' || value === null) return {};
  const candidate = value as MessageDispositionPreferences;
  const threads = Object.fromEntries(
    Object.entries(candidate.threads ?? {}).filter(
      (entry): entry is [string, MessageWorkDisposition] => entry[0].length > 0 && isDisposition(entry[1]),
    ),
  );
  return {
    ...(isDisposition(candidate.global) ? { global: candidate.global } : {}),
    ...(Object.keys(threads).length > 0 ? { threads } : {}),
    ...(candidate.onboardingSeen === true ? { onboardingSeen: true } : {}),
  };
}

export function resolveMessageDispositionPreference(
  projectRoot: string,
  threadId?: string,
): MessageDispositionPreferenceSnapshot {
  const preference = sanitizeDispositionPreferences(readUserPreferences(projectRoot).messageDisposition);
  const thread = threadId ? (preference.threads?.[threadId] ?? null) : null;
  const global = preference.global ?? null;
  if (thread) {
    return {
      productDefault: MESSAGE_DISPOSITION_PRODUCT_DEFAULT,
      global,
      thread,
      effective: thread,
      source: 'thread',
      onboardingSeen: preference.onboardingSeen === true,
    };
  }
  if (global) {
    return {
      productDefault: MESSAGE_DISPOSITION_PRODUCT_DEFAULT,
      global,
      thread: null,
      effective: global,
      source: 'global',
      onboardingSeen: preference.onboardingSeen === true,
    };
  }
  return {
    productDefault: MESSAGE_DISPOSITION_PRODUCT_DEFAULT,
    global: null,
    thread: null,
    effective: MESSAGE_DISPOSITION_PRODUCT_DEFAULT,
    source: 'product',
    onboardingSeen: preference.onboardingSeen === true,
  };
}

export function saveMessageDispositionPreference(
  projectRoot: string,
  input:
    | { scope: 'global'; disposition: MessageWorkDisposition | null }
    | { scope: 'thread'; threadId: string; disposition: MessageWorkDisposition | null }
    | { scope: 'onboarding'; seen: true },
): MessageDispositionPreferenceSnapshot {
  updateUserPreferences(projectRoot, (current) => {
    const existing = sanitizeDispositionPreferences(current.messageDisposition);
    if (input.scope === 'onboarding') {
      return { ...current, messageDisposition: { ...existing, onboardingSeen: true } };
    }
    if (input.scope === 'global') {
      const next = { ...existing };
      if (input.disposition) next.global = input.disposition;
      else delete next.global;
      return { ...current, messageDisposition: next };
    }
    const threads = { ...(existing.threads ?? {}) };
    if (input.disposition) threads[input.threadId] = input.disposition;
    else delete threads[input.threadId];
    const next = { ...existing };
    if (Object.keys(threads).length > 0) next.threads = threads;
    else delete next.threads;
    return { ...current, messageDisposition: next };
  });
  return resolveMessageDispositionPreference(projectRoot, input.scope === 'thread' ? input.threadId : undefined);
}

function sanitizeThemeConfig(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

export interface ThemeConfigResolution {
  themeConfig: string | null;
  /** Where the returned value came from. */
  source: 'preferences' | 'env-fallback' | 'none';
  /** True when a legacy process.env THEME_CONFIG value was migrated into the JSON store on this read. */
  migratedFromEnv: boolean;
}

/**
 * F770: theme config lives in user-preferences.json (runtime-readable, no
 * restart). The legacy THEME_CONFIG env value is honored as a read-only
 * fallback and migrated into the JSON store on first read so existing users
 * do not lose their theme.
 */
export function resolveThemeConfig(projectRoot: string): ThemeConfigResolution {
  const stored = sanitizeThemeConfig(readUserPreferences(projectRoot).themeConfig);
  if (stored) return { themeConfig: stored, source: 'preferences', migratedFromEnv: false };
  const envValue = sanitizeThemeConfig(process.env.THEME_CONFIG);
  if (envValue) {
    updateUserPreferences(projectRoot, (current) => ({ ...current, themeConfig: envValue }));
    return { themeConfig: envValue, source: 'env-fallback', migratedFromEnv: true };
  }
  return { themeConfig: null, source: 'none', migratedFromEnv: false };
}

export function saveThemeConfig(projectRoot: string, value: string): ThemeConfigResolution {
  const sanitized = sanitizeThemeConfig(value);
  updateUserPreferences(projectRoot, (current) => {
    const next = { ...current };
    if (sanitized) next.themeConfig = sanitized;
    else delete next.themeConfig;
    return next;
  });
  // Return the just-written value directly: re-resolving here would fall back
  // to the legacy env value (or re-migrate it) right after an intentional clear.
  if (sanitized) return { themeConfig: sanitized, source: 'preferences', migratedFromEnv: false };
  return { themeConfig: null, source: 'none', migratedFromEnv: false };
}

// Keep in sync with the pino LevelWithSilent set and env-registry allowedValues.
const LOG_LEVEL_VALUES = new Set(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']);

function sanitizeLogLevel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return LOG_LEVEL_VALUES.has(trimmed) ? trimmed : undefined;
}

export interface LogLevelResolution {
  logLevel: string | null;
  /** Where the returned value came from. */
  source: 'preferences' | 'env-fallback' | 'none';
  /** True when a legacy process.env LOG_LEVEL value was migrated into the JSON store on this read. */
  migratedFromEnv: boolean;
}

/**
 * F770: log level lives in user-preferences.json and is applied at runtime via
 * setRuntimeLogLevel (no restart). The legacy LOG_LEVEL env value is honored as
 * a read-only startup fallback (logger.ts reads it at module load) and migrated
 * into the JSON store on first read so existing users do not lose their level.
 */
export function readStoredLogLevel(projectRoot: string): string | null {
  return sanitizeLogLevel(readUserPreferences(projectRoot).logLevel) ?? null;
}

export function resolveLogLevel(projectRoot: string): LogLevelResolution {
  const stored = readStoredLogLevel(projectRoot);
  if (stored) return { logLevel: stored, source: 'preferences', migratedFromEnv: false };
  const envValue = sanitizeLogLevel(process.env.LOG_LEVEL);
  if (envValue) {
    updateUserPreferences(projectRoot, (current) => ({ ...current, logLevel: envValue }));
    return { logLevel: envValue, source: 'env-fallback', migratedFromEnv: true };
  }
  return { logLevel: null, source: 'none', migratedFromEnv: false };
}

export function saveLogLevel(projectRoot: string, value: string): LogLevelResolution {
  const sanitized = sanitizeLogLevel(value);
  updateUserPreferences(projectRoot, (current) => {
    const next = { ...current };
    if (sanitized) next.logLevel = sanitized;
    else delete next.logLevel;
    return next;
  });
  // Return the just-written value directly: re-resolving here would fall back
  // to the legacy env value (or re-migrate it) right after an intentional clear.
  if (sanitized) return { logLevel: sanitized, source: 'preferences', migratedFromEnv: false };
  return { logLevel: null, source: 'none', migratedFromEnv: false };
}

function sanitizeDeniedRoots(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
        .map((entry) => entry.trim()),
    ),
  ];
}

export interface DeniedRootsResolution {
  /** Custom denied roots only — platform defaults are always merged by the consumer. */
  deniedRoots: string[];
  /** Where the returned value came from. */
  source: 'preferences' | 'env-fallback' | 'none';
  /** True when a legacy process.env PROJECT_DENIED_ROOTS value was migrated into the JSON store on this read. */
  migratedFromEnv: boolean;
}

/**
 * F770: custom denied roots live in user-preferences.json and are read per
 * validation call (hot, same as the legacy env read). The key distinction from
 * theme/log-level: an EMPTY ARRAY is a deliberate stored state — it clears all
 * custom denials and must override the env fallback, otherwise clearing the
 * blacklist would silently revive the env value (security control resurrection).
 * The legacy PROJECT_DENIED_ROOTS env value is migrated into the store on first
 * read when the key is absent entirely.
 */
export function resolveDeniedRoots(projectRoot: string): DeniedRootsResolution {
  const prefs = readUserPreferences(projectRoot);
  if (Array.isArray(prefs.deniedRoots)) {
    return { deniedRoots: sanitizeDeniedRoots(prefs.deniedRoots), source: 'preferences', migratedFromEnv: false };
  }
  const envValue = process.env.PROJECT_DENIED_ROOTS;
  if (envValue?.trim()) {
    const custom = [...new Set(envValue.split(delimiter).filter(Boolean).map(canonicalizeDeniedRoot))];
    updateUserPreferences(projectRoot, (current) => ({ ...current, deniedRoots: custom }));
    return { deniedRoots: custom, source: 'env-fallback', migratedFromEnv: true };
  }
  return { deniedRoots: [], source: 'none', migratedFromEnv: false };
}

/**
 * Canonicalize one denied root for comparison against realpath'd candidate
 * paths. validateProjectPathDetailed realpaths the candidate before checking,
 * and macOS aliases /tmp, /var, /etc behind /private/... symlinks — a stored
 * literal '/tmp/x' would never match the candidate's '/private/tmp/x', a
 * silent security-control failure. Resolve the longest EXISTING ancestor so
 * not-yet-created directories still canonicalize (and saving them never fails
 * just because the target does not exist yet).
 */
function canonicalizeDeniedRoot(entry: string): string {
  const abs = resolve(entry);
  let probe = abs;
  const tail: string[] = [];
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) break;
    tail.unshift(basename(probe));
    probe = parent;
  }
  try {
    const canonical = realpathSync(probe);
    return tail.length === 0 ? canonical : resolve(canonical, ...tail);
  } catch {
    return abs;
  }
}

export function saveDeniedRoots(projectRoot: string, roots: string[]): DeniedRootsResolution {
  const sanitized = [...new Set(sanitizeDeniedRoots(roots).map(canonicalizeDeniedRoot))];
  updateUserPreferences(projectRoot, (current) => ({ ...current, deniedRoots: sanitized }));
  // Return the just-written value directly: re-resolving here would fall back
  // to the legacy env value right after an intentional clear of all denials.
  return { deniedRoots: sanitized, source: 'preferences', migratedFromEnv: false };
}

// --- F770 data retention (lifecycle presets) ---

const RETENTION_MAX_SECONDS = 2147483647; // Redis EXPIRE upper bound (int32)

function sanitizeRetentionSeconds(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const floored = Math.floor(value);
  return floored >= 0 && floored <= RETENTION_MAX_SECONDS ? floored : undefined;
}

/**
 * F770: retention presets live in user-preferences.json and apply to NEW writes
 * via the in-memory TTL provider (no restart, zero read-side IO). Deliberately
 * NO env→JSON auto-migration (unlike theme/log-level): six legacy env vars
 * lossily compress into five categories — drafts stay a functional constant —
 * so until the owner picks a preset each category falls back read-only to its
 * legacy env value. A stored 0 means "keep forever" and, like an empty
 * deniedRoots list, is meaningful: it overrides the env fallback.
 */
export function resolveRetentionConfig(projectRoot: string): RetentionConfigResolution {
  const stored = readUserPreferences(projectRoot).retentionConfig;
  const config: RetentionConfigResolution['config'] = { message: 0, thread: 0, task: 0, summary: 0, backlog: 0 };
  const sources: RetentionConfigResolution['sources'] = {
    message: 'default',
    thread: 'default',
    task: 'default',
    summary: 'default',
    backlog: 'default',
  };
  for (const category of RETENTION_CATEGORY_VALUES) {
    const storedValue = sanitizeRetentionSeconds(stored?.[category]);
    if (stored?.[category] !== undefined && storedValue !== undefined) {
      config[category] = storedValue;
      sources[category] = 'preferences';
      continue;
    }
    const envValue = parseEnvTtlSeconds(process.env[RETENTION_ENV_BY_CATEGORY[category]]);
    if (envValue !== null) {
      config[category] = envValue;
      sources[category] = 'env-fallback';
    }
  }
  return { config, sources };
}

/**
 * Merge per-category seconds into the JSON store and push the resolved values
 * into the in-memory TTL provider so new writes pick them up in this process.
 * Invalid provided keys are dropped (the route validates for UX). Absent keys
 * are left untouched.
 */
export function saveRetentionConfig(
  projectRoot: string,
  config: RetentionConfigPreferences,
): RetentionConfigResolution {
  updateUserPreferences(projectRoot, (current) => {
    const existing = current.retentionConfig ?? {};
    const next: RetentionConfigPreferences = { ...existing };
    for (const category of RETENTION_CATEGORY_VALUES) {
      if (!(category in (config ?? {}))) continue;
      const sanitized = sanitizeRetentionSeconds(config[category]);
      if (sanitized === undefined) continue;
      next[category] = sanitized;
    }
    return { ...current, retentionConfig: next };
  });
  const resolution = resolveRetentionConfig(projectRoot);
  const pushed: Partial<Record<RetentionCategory, number | null>> = {};
  for (const category of RETENTION_CATEGORY_VALUES) {
    if (category in (config ?? {}))
      pushed[category] = resolution.config[category] === 0 ? null : resolution.config[category];
  }
  pushRetentionTtlSecondsAll(pushed);
  return resolution;
}

/**
 * Startup wiring: resolve the persisted presets once and push every category
 * into the in-memory provider, so store reads stay zero-IO for the rest of the
 * process. Unpushed categories keep the live env fallback — exactly the
 * pre-#770 behavior.
 */
export function initRetentionTtlFromPreferences(projectRoot: string): void {
  const resolution = resolveRetentionConfig(projectRoot);
  pushRetentionTtlSecondsAll(
    Object.fromEntries(
      RETENTION_CATEGORY_VALUES.map((category) => [
        category,
        resolution.config[category] === 0 ? null : resolution.config[category],
      ]),
    ) as Record<RetentionCategory, number | null>,
  );
}
