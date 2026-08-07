/**
 * Context Capacity Resolver
 * clowder-ai#1208: one member setting, read once for each invocation.
 *
 * Manual mode is intentionally literal: an explicit `contextWindow` is the
 * effective window for the next invocation. The runtime does not silently
 * clamp it to a model catalog entry or a prior session observation. A wrong
 * value is surfaced by the provider and can be corrected by the user.
 *
 * Auto mode uses a carrier report when one is available, otherwise the model
 * catalog. Unknown bindings remain unresolved instead of receiving a guessed
 * provider-wide default.
 */

import { catRegistry } from '@cat-cafe/shared';
import { createModuleLogger } from '../infrastructure/logger.js';
import { getContextWindowFallback, resolveContextWindow } from './context-window-sizes.js';

const log = createModuleLogger('context-capacity');
const DEFAULT_OUTPUT_RESERVE = 16_000;

export type ContextCapacitySource = 'reported' | 'manual' | 'catalog' | 'unresolved';

export interface ResolvedContextCapacity {
  /** Effective context window tokens (total capacity). */
  readonly windowTokens: number;
  /** Tokens available for input after output/safety reserve. */
  readonly inputCeilingTokens: number;
  /** Where the effective value came from. */
  readonly source: ContextCapacitySource;
  /** Human-readable source description for Hub/debug output. */
  readonly provenance: string;
  /** Whether the denominator is explicit enough for automatic lifecycle actions. */
  readonly actionable: boolean;
}

export interface ResolveCapacityOptions {
  catId: string;
  /**
   * Factory/snapshot-time member value when the caller owns the canonical config.
   * `null` means the caller captured Auto mode and prevents a later registry read.
   */
  memberWindowTokens?: number | null | undefined;
  /** Carrier-reported window size, used only in Auto mode. */
  reportedWindowSize?: number | undefined;
  /** Effective model name for Auto-mode catalog lookup. */
  model?: string | undefined;
}

/**
 * Return the member's explicit context window, if any.
 *
 * Compatibility: a legacy `cli.contextWindow` is read only when the canonical
 * top-level value is absent. The next catalog save promotes and strips it.
 */
export function getMemberWindowSetting(catId: string): number | undefined {
  const config = catRegistry.tryGet(catId)?.config;
  if (!config) return undefined;
  if (config.contextWindow != null) return config.contextWindow;
  const legacyCli = (config.cli as { contextWindow?: number } | undefined)?.contextWindow;
  return legacyCli != null && legacyCli > 0 ? legacyCli : undefined;
}

/** Internal derivation only; this is not a user-facing prompt-policy knob. */
export function getMemberOutputReserve(_catId: string): number {
  return DEFAULT_OUTPUT_RESERVE;
}

/** Resolve the effective capacity for one member invocation. */
export function resolveContextCapacity(options: ResolveCapacityOptions): ResolvedContextCapacity {
  const { catId, reportedWindowSize, model } = options;
  const manualWindow =
    options.memberWindowTokens === undefined
      ? getMemberWindowSetting(catId)
      : (options.memberWindowTokens ?? undefined);

  let windowTokens = 0;
  let source: ContextCapacitySource = 'unresolved';
  let provenance = 'No manual value, carrier report, or model catalog entry is available';
  let actionable = false;

  if (manualWindow != null && Number.isFinite(manualWindow) && manualWindow > 0) {
    windowTokens = manualWindow;
    source = 'manual';
    provenance = `Member context window → ${manualWindow.toLocaleString()} tokens`;
    actionable = true;
  } else if (reportedWindowSize != null && Number.isFinite(reportedWindowSize) && reportedWindowSize > 0) {
    const reported = resolveContextWindow(reportedWindowSize, model ?? '');
    if (reported != null) {
      windowTokens = reported;
      source = 'reported';
      provenance = `Carrier reported ${reported.toLocaleString()} tokens`;
      actionable = true;
    }
  } else if (model) {
    const catalogWindow = getContextWindowFallback(model);
    if (catalogWindow != null) {
      windowTokens = catalogWindow;
      source = 'catalog';
      provenance = `Model catalog (${model}) → ${catalogWindow.toLocaleString()} tokens`;
    }
  }

  const inputCeilingTokens = Math.max(0, windowTokens - getMemberOutputReserve(catId));
  const result: ResolvedContextCapacity = {
    windowTokens,
    inputCeilingTokens,
    source,
    provenance,
    actionable,
  };

  log.debug({ catId, ...result }, 'resolved invocation context capacity');
  return result;
}

/** Return undefined only when Auto mode has no report or catalog entry. */
export function resolveEffectiveWindowTokens(options: ResolveCapacityOptions): number | undefined {
  const capacity = resolveContextCapacity(options);
  return capacity.source === 'unresolved' ? undefined : capacity.windowTokens;
}

/** History receives a scalar share of the invocation-owned input ceiling. */
export function deriveHistoryContextTokenCeiling(inputCeilingTokens: number): number {
  return Math.floor(Math.max(0, inputCeilingTokens) * 0.85);
}
