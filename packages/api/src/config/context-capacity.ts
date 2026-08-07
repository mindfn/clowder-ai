/**
 * Context Capacity Resolver
 * clowder-ai#1208: single source of truth for a member's effective context capacity.
 *
 * Resolution order (discovery):
 *   1. CLI-reported contextWindowSize (exact, from live session).
 *   2. Model catalog — known model capacity (e.g. opus 1M, GLM-5.2 1M).
 *   3. Nothing → unresolved; lifecycle actions must fail closed and the UI shows the gap.
 *
 * Manual cap (CatConfig.contextWindow) is always honored as a ceiling on top of
 * the discovered value.  Users whose gateway caps below the model's native window
 * should set this field (e.g. OpenCode binding through a 128K gateway → set 128000).
 *
 * Effective input ceiling = effectiveWindow - outputReserve.  This is the shared
 * denominator used by prompt assembly, context health, and client-native window
 * settings.
 *
 * Binding key: every resolution carries a composite identity key
 * (member/client/account/provider/model/carrier) so consumers can detect
 * binding changes and session pins can invalidate correctly.
 *
 * Confidence tiers (clowder-ai#1208 Item 2):
 *   exact  (1.0) — CLI reported from live session
 *   manual (0.95) — user explicitly configured, high trust
 *   catalog (0.7) — model catalog lookup, probable but unconfirmed
 *   unresolved (0) — no usable source
 *
 * `actionable` is strict: only exact/manual (or catalog/default capped by a manual
 * window) are actionable for lifecycle actions (auto-seal, handoff).  Catalog/default
 * alone are NOT actionable — they must not masquerade as confirmed values.
 */

import { catRegistry, type SessionCapacityPin } from '@cat-cafe/shared';
import { createModuleLogger } from '../infrastructure/logger.js';
import { getContextWindowFallback, resolveContextWindow } from './context-window-sizes.js';

const log = createModuleLogger('context-capacity');

const DEFAULT_OUTPUT_RESERVE = 16_000;

// ─── Binding Key ─────────────────────────────────────────────────────

/** Composite identity for what determines a member's context window. */
export interface CapacityBindingKey {
  readonly member: string;
  readonly client: string;
  readonly account?: string;
  readonly provider?: string;
  readonly model: string;
  readonly carrier?: string;
}

/**
 * Deterministic fingerprint of a binding key.  Used for session pin
 * invalidation — when the fingerprint changes, the binding changed
 * (e.g. model switch) and the pin must be reset.
 */
export function computeBindingFingerprint(key: CapacityBindingKey): string {
  return [key.member, key.client, key.account ?? '', key.provider ?? '', key.model, key.carrier ?? ''].join('|');
}

// ─── Confidence ──────────────────────────────────────────────────────

/** Confidence tier for the resolved window. */
export type ContextCapacityConfidence =
  | 'exact' // CLI-reported usage for the live session
  | 'catalog' // Known model/provider catalog
  | 'manual' // User-supplied manual cap without discovery
  | 'unresolved'; // No usable source

/** Numeric confidence (0.0–1.0) per tier. */
export const CONFIDENCE_SCORES: Readonly<Record<ContextCapacityConfidence, number>> = {
  exact: 1.0,
  manual: 0.95,
  catalog: 0.7,
  unresolved: 0,
};

// ─── Resolved Capacity ──────────────────────────────────────────────

export interface ResolvedContextCapacity {
  /** Effective context window tokens (total capacity). */
  readonly windowTokens: number;
  /** Tokens available for input after output/safety reserve. */
  readonly inputCeilingTokens: number;
  /** How the window was determined. */
  readonly source: ContextCapacityConfidence;
  /** Numeric confidence (0.0–1.0) for graduated decision-making. */
  readonly confidence: number;
  /** Human-readable provenance string for UI/debug. */
  readonly provenance: string;
  /**
   * Whether the value is authoritative enough for automatic lifecycle
   * actions (auto-seal, handoff, compress).
   *
   * True ONLY for:
   * - exact (CLI confirmed)
   * - manual (user explicitly set, sole source)
   * - catalog where a manual cap is binding (user confirmed the cap)
   *
   * catalog WITHOUT a manual cap is NOT actionable — it
   * must not masquerade as confirmed values (clowder-ai#1208 Item 2).
   */
  readonly actionable: boolean;
  /** Composite binding identity that produced this resolution. */
  readonly bindingKey: CapacityBindingKey;
  /** Deterministic fingerprint of bindingKey (for session pin checks). */
  readonly fingerprint: string;
  /** Timestamp (epoch ms) when this resolution was computed. */
  readonly observedAt: number;
}

export interface ResolveCapacityOptions {
  catId: string;
  /** Factory-time member value when the caller already owns the canonical config. */
  memberWindowCap?: number | undefined;
  /** CLI-reported window size, if any. */
  reportedWindowSize?: number | undefined;
  /** Effective model name for catalog lookups. */
  model?: string | undefined;
  /** Provider id, included in the binding identity. */
  provider?: string | undefined;
  /** Client ID (e.g. 'anthropic', 'openai', 'opencode') for binding key. */
  client?: string | undefined;
  /** Account ref (e.g. 'claude', 'sponsor1') for binding key. */
  account?: string | undefined;
  /** Carrier type (e.g. 'cli', 'codex', 'bg', 'mcp') for binding key. */
  carrier?: string | undefined;
}

/**
 * Get the member's manually-configured context window cap, if any.
 * Returns the explicit cap (positive integer) or undefined (Auto mode).
 *
 * Compat: when top-level `contextWindow` is absent, reads legacy `cli.contextWindow`
 * as a Manual cap. Next canonical save writes the top-level field.
 */
export function getMemberWindowCap(catId: string): number | undefined {
  const config = catRegistry.tryGet(catId)?.config;
  if (!config) return undefined;
  // Top-level contextWindow is the canonical source (#1208).
  if (config.contextWindow != null) return config.contextWindow;
  // Legacy compat: cli.contextWindow written by older catalogs.
  const legacyCli = (config.cli as { contextWindow?: number } | undefined)?.contextWindow;
  return legacyCli != null && legacyCli > 0 ? legacyCli : undefined;
}

/**
 * Get the output reserve for deriving input ceiling from the window.
 * Internal derivation only — never exposed to users (clowder-ai#1208).
 */
export function getMemberOutputReserve(_catId: string): number {
  return DEFAULT_OUTPUT_RESERVE;
}

/**
 * Resolve the member's effective context capacity for the current invocation.
 *
 * Rules:
 * - Manual cap is always honored as the ceiling.  If discovery exceeds it, the
 *   effective value is the cap and provenance reflects "capped".
 * - Auto without discovery returns the manual cap if present; otherwise unresolved.
 * - Discovery values are never silently expanded above a manual cap.
 * - When nothing is available, returns unresolved with actionable=false.
 * - actionable is strict: catalog without manual cap is NOT actionable.
 */
export function resolveContextCapacity(options: ResolveCapacityOptions): ResolvedContextCapacity {
  const { catId, reportedWindowSize, model, provider, client, account, carrier } = options;
  const manualCap = options.memberWindowCap ?? getMemberWindowCap(catId);

  // Build binding key from available context, falling back to config.
  const config = catRegistry.tryGet(catId)?.config;
  const bindingKey: CapacityBindingKey = {
    member: catId,
    client: client ?? config?.clientId ?? 'unknown',
    account: account ?? config?.accountRef,
    provider: provider ?? config?.provider,
    model: model ?? config?.defaultModel ?? 'unknown',
    carrier,
  };
  const fingerprint = computeBindingFingerprint(bindingKey);
  const observedAt = Date.now();

  let discovered: number | undefined;
  let source: ContextCapacityConfidence = 'unresolved';
  let provenance = 'No discovery source available';

  // Step 1: CLI-reported window (exact, from live session)
  if (reportedWindowSize != null && Number.isFinite(reportedWindowSize) && reportedWindowSize > 0) {
    discovered = resolveContextWindow(reportedWindowSize, model ?? '');
    if (discovered != null) {
      source = 'exact';
      provenance = `CLI reported ${discovered.toLocaleString()} tokens`;
    }
  }

  // Step 2: Model catalog — use the known model capacity when available.
  // This correctly resolves models like GLM-5.2 (1M) even through OpenCode,
  // because those bindings expose the model's native window.
  if (discovered == null && model) {
    discovered = getContextWindowFallback(model);
    if (discovered != null) {
      source = 'catalog';
      provenance = `Model catalog (${model}) → ${discovered.toLocaleString()} tokens`;
    }
  }

  let windowTokens: number;
  let manualCapIsBinding = false;
  if (manualCap != null) {
    if (discovered != null) {
      windowTokens = Math.min(discovered, manualCap);
      manualCapIsBinding = windowTokens < discovered;
      if (manualCapIsBinding) {
        provenance = `${provenance}; capped to member limit ${manualCap.toLocaleString()}`;
      } else {
        provenance = `${provenance}; member limit ${manualCap.toLocaleString()} not binding`;
      }
    } else {
      windowTokens = manualCap;
      source = 'manual';
      provenance = `Member manual cap → ${manualCap.toLocaleString()} tokens`;
    }
  } else if (discovered != null) {
    windowTokens = discovered;
  } else {
    return {
      windowTokens: 0,
      inputCeilingTokens: 0,
      source: 'unresolved',
      confidence: CONFIDENCE_SCORES.unresolved,
      provenance,
      actionable: false,
      bindingKey,
      fingerprint,
      observedAt,
    };
  }

  const outputReserve = getMemberOutputReserve(catId);
  const inputCeilingTokens = Math.max(0, windowTokens - outputReserve);
  const confidence = CONFIDENCE_SCORES[source];

  // actionable = confirmed enough for lifecycle actions (auto-seal, handoff).
  // - exact/manual are inherently actionable.
  // - catalog becomes actionable ONLY when a manual cap is binding
  //   (the user confirmed the effective window via their cap setting).
  const actionable = source === 'exact' || source === 'manual' || (manualCap != null && manualCapIsBinding);

  log.debug(
    { catId, windowTokens, inputCeilingTokens, source, confidence, actionable, fingerprint, provenance },
    'resolved context capacity',
  );

  return {
    windowTokens,
    inputCeilingTokens,
    source,
    confidence,
    provenance,
    actionable,
    bindingKey,
    fingerprint,
    observedAt,
  };
}

/**
 * Convenience: resolve capacity and return just the effective window tokens.
 * Returns `undefined` only when fully unresolved (no source at all).
 * Catalog values ARE returned here — they're usable for sizing
 * even though they're not actionable for lifecycle decisions.
 */
export function resolveEffectiveWindowTokens(options: ResolveCapacityOptions): number | undefined {
  const capacity = resolveContextCapacity(options);
  return capacity.source !== 'unresolved' ? capacity.windowTokens : undefined;
}

// ─── Session Capacity Pin ────────────────────────────────────────────

// SessionCapacityPin type is defined in @cat-cafe/shared (session.ts)
// and re-exported here for backward compatibility.
export type { SessionCapacityPin } from '@cat-cafe/shared';

/**
 * Apply session pin semantics: shrink-no-expand within same binding.
 *
 * Rules:
 * - No existing pin → pin to the resolved value.
 * - Same fingerprint, resolved ≤ pinned → shrink to resolved (safety).
 * - Same fingerprint, resolved > pinned → keep pinned (stability).
 * - Different fingerprint → invalidate pin, use resolved (binding changed).
 *
 * Returns the effective capacity (potentially clamped) and the updated pin.
 * The caller is responsible for persisting the pin (in-memory map or SessionRecord).
 */
export function applySessionPin(
  resolved: ResolvedContextCapacity,
  existingPin: SessionCapacityPin | undefined,
): { effective: ResolvedContextCapacity; pin: SessionCapacityPin } {
  const pinResolved = (value: ResolvedContextCapacity): SessionCapacityPin => ({
    windowTokens: value.windowTokens,
    inputCeilingTokens: value.inputCeilingTokens,
    fingerprint: value.fingerprint,
    pinnedAt: value.observedAt,
    source: value.source,
    confidence: value.confidence,
    actionable: value.actionable,
    provenance: value.provenance,
  });

  // No pin yet or binding changed → pin to resolved value.
  if (!existingPin || existingPin.fingerprint !== resolved.fingerprint) {
    return { effective: resolved, pin: pinResolved(resolved) };
  }

  // An unresolved pre-provider snapshot is not a real zero-token capacity.
  // It must neither erase a prior trusted session value nor block the first
  // carrier report from establishing one for this binding.
  if (resolved.source === 'unresolved') {
    if (existingPin.windowTokens > 0 && existingPin.source && existingPin.source !== 'unresolved') {
      const effective: ResolvedContextCapacity = {
        ...resolved,
        windowTokens: existingPin.windowTokens,
        inputCeilingTokens: existingPin.inputCeilingTokens,
        source: existingPin.source,
        confidence: existingPin.confidence ?? CONFIDENCE_SCORES[existingPin.source],
        actionable: existingPin.actionable ?? (existingPin.source === 'exact' || existingPin.source === 'manual'),
        provenance: `${existingPin.provenance ?? 'Prior session discovery'}; restored from session pin`,
      };
      return { effective, pin: existingPin };
    }
    return { effective: resolved, pin: pinResolved(resolved) };
  }

  if (existingPin.windowTokens <= 0) {
    return { effective: resolved, pin: pinResolved(resolved) };
  }

  if (
    resolved.windowTokens === existingPin.windowTokens &&
    existingPin.source &&
    (existingPin.confidence ?? 0) > resolved.confidence
  ) {
    const effective: ResolvedContextCapacity = {
      ...resolved,
      source: existingPin.source,
      confidence: existingPin.confidence ?? CONFIDENCE_SCORES[existingPin.source],
      actionable: existingPin.actionable ?? false,
      provenance: `${existingPin.provenance ?? resolved.provenance}; retained from stronger session pin`,
    };
    return { effective, pin: existingPin };
  }

  // Same binding, resolved ≤ pinned → shrink (safety).
  if (resolved.windowTokens <= existingPin.windowTokens) {
    return { effective: resolved, pin: pinResolved(resolved) };
  }

  // Same binding, resolved > pinned → keep pinned (shrink-no-expand).
  const clamped: ResolvedContextCapacity = {
    ...resolved,
    windowTokens: existingPin.windowTokens,
    inputCeilingTokens: existingPin.inputCeilingTokens,
    ...(existingPin.source && (existingPin.confidence ?? 0) > resolved.confidence
      ? {
          source: existingPin.source,
          confidence: existingPin.confidence ?? CONFIDENCE_SCORES[existingPin.source],
          actionable: existingPin.actionable ?? false,
        }
      : {}),
    provenance: `${resolved.provenance}; session-pinned at ${existingPin.windowTokens.toLocaleString()} (shrink-no-expand)`,
  };

  const currentResolutionIsStronger =
    resolved.confidence > (existingPin.confidence ?? 0) || (resolved.actionable && existingPin.actionable === false);
  return {
    effective: clamped,
    pin: currentResolutionIsStronger ? { ...pinResolved(clamped), pinnedAt: existingPin.pinnedAt } : existingPin,
  };
}

/** History receives a scalar share of the invocation-owned input ceiling. */
export function deriveHistoryContextTokenCeiling(inputCeilingTokens: number): number {
  return Math.floor(Math.max(0, inputCeilingTokens) * 0.85);
}
