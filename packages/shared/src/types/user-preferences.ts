/**
 * User Preferences (F166)
 * UI-level preferences persisted to .cat-cafe/user-preferences.json.
 * Separate from cat-catalog.json (configuration, not preference).
 */

import type { ConversationViewPreferences } from '../conversation-view-preference.js';
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
export type ThreadAttentionMemberSort = 'manual' | 'running-first';

export interface ThreadAttentionPreferences {
  aliases?: Record<string, string>;
  open?: Record<string, boolean>;
  /** F322: collapsed Groups reveal attention shortcuts unless explicitly disabled. */
  collapsedPeek?: Record<string, boolean>;
  /** Missing inherits manual order. Running-first is a view; membership order remains durable truth. */
  memberSort?: Record<string, ThreadAttentionMemberSort>;
}

export type BubbleDisplayDefaultPreference = 'expanded' | 'collapsed';

export interface BubbleDefaultPreferences {
  /** F322: personal default for execution records. Missing inherits runtime/product configuration. */
  cliOutput?: BubbleDisplayDefaultPreference;
}

export interface UserPreferences {
  /** F321: background curation preference and its durable first-enable boundary. */
  memoryCuration?: { enabled: boolean; startedAt?: number; curatorCatId?: string };
  /** F166: Custom display order of cats. catIds not in this list fall back to cat-template.json order. */
  catOrder?: string[];
  /** F264: author-declared current-work/next-work preference inheritance. */
  messageDisposition?: MessageDispositionPreferences;
  /** F277: owner-only Group aliases and fold overrides. Membership lives in thread metadata. No TTL. */
  threadAttention?: ThreadAttentionPreferences;
  /** F322: owner-only presentation defaults. No TTL. */
  bubbleDefaults?: BubbleDefaultPreferences;
  /** F322: owner-only per-thread conversation presentation. No TTL. */
  conversationViews?: ConversationViewPreferences;
}
