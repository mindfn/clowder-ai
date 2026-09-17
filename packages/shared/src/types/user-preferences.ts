/**
 * User Preferences (F166)
 * UI-level preferences persisted to .cat-cafe/user-preferences.json.
 * Separate from cat-catalog.json (configuration, not preference).
 */

import type { MessageWorkDisposition } from './queue-receipt.js';

export type MessageDispositionPreferenceSource = 'thread' | 'global' | 'product';

export interface MessageDispositionPreferences {
  /** Owner-wide fallback. Missing inherits the product default. */
  global?: MessageWorkDisposition;
  /** Per-thread override. Missing entry inherits global/product. */
  threads?: Record<string, MessageWorkDisposition>;
  /** Monotonic JIT-onboarding receipt. */
  onboardingSeen?: boolean;
}

export interface MessageDispositionPreferenceSnapshot {
  productDefault: MessageWorkDisposition;
  global: MessageWorkDisposition | null;
  thread: MessageWorkDisposition | null;
  effective: MessageWorkDisposition;
  source: MessageDispositionPreferenceSource;
  onboardingSeen: boolean;
}

/** F277: owner-scoped Group read model projected from per-thread metadata. */
export interface ThreadAttentionGroup {
  id: string;
  name?: string;
  threadIds: string[];
}

/** F277: private presentation state keyed only by a stable Group anchor. */
export interface ThreadAttentionPreferences {
  aliases?: Record<string, string>;
  open?: Record<string, boolean>;
}

/**
 * F770: retention categories governed by the lifecycle presets. Drafts are
 * deliberately NOT a category — the 300s draft TTL is an auto-save functional
 * constant (RedisDraftStore DEFAULT_TTL), not a retention strategy.
 */
export const RETENTION_CATEGORY_VALUES = ['message', 'thread', 'task', 'summary', 'backlog'] as const;
export type RetentionCategory = (typeof RETENTION_CATEGORY_VALUES)[number];

/** Seconds per category; 0 = keep forever. Absent key = not set (env fallback applies). */
export type RetentionConfigPreferences = Partial<Record<RetentionCategory, number>>;

export type RetentionConfigSource = 'preferences' | 'env-fallback' | 'default';

export interface RetentionConfigResolution {
  /** Effective seconds per category; 0 = keep forever. */
  config: Record<RetentionCategory, number>;
  /** Where each category's effective value came from. */
  sources: Record<RetentionCategory, RetentionConfigSource>;
}

export interface UserPreferences {
  /** F166: Custom display order of cats. catIds not in this list fall back to cat-template.json order. */
  catOrder?: string[];
  /** F264: author-declared current-work/next-work preference inheritance. */
  messageDisposition?: MessageDispositionPreferences;
  /** F277: owner-only Group aliases and fold overrides. Membership lives in thread metadata. No TTL. */
  threadAttention?: ThreadAttentionPreferences;
  /**
   * F770: OKLCH theme config payload (themeStore shape, JSON string). Migrated
   * from the THEME_CONFIG env var so theme changes apply without a restart.
   */
  themeConfig?: string;
  /**
   * F770: runtime log level (pino LevelWithSilent). Migrated from the LOG_LEVEL
   * env var so log level changes apply without a restart.
   */
  logLevel?: string;
  /**
   * F770: extra denied project roots for path validation (denylist mode),
   * absolute paths. Migrated from the PROJECT_DENIED_ROOTS env var. An empty
   * array is meaningful: it clears all custom denials and overrides the env
   * fallback (security control must not silently revive).
   */
  deniedRoots?: string[];
  /**
   * F770: data-retention TTL presets in seconds per category (0 = keep forever).
   * Migrated from the *_TTL_SECONDS env vars so retention changes apply to new
   * writes without a restart. Unlike theme/log-level there is deliberately NO
   * env→JSON auto-migration: six env vars (incl. DRAFT_TTL_SECONDS) lossily
   * compress into five categories — drafts stay a functional constant outside
   * the presets. Until the owner picks a preset, each category falls back
   * read-only to its legacy env value.
   */
  retentionConfig?: RetentionConfigPreferences;
}
