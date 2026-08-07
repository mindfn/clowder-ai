/**
 * #1208 invocation capacity owner.
 *
 * Each member invocation reads the current member setting once. Prompt
 * assembly, lifecycle checks, and provider-native controls consume that same
 * snapshot. Auto mode may refine it from a trusted carrier report during the
 * invocation; manual mode remains literal. Nothing is pinned across later
 * invocations.
 */

import {
  type CatId,
  type ContextHealth,
  catRegistry,
  type SessionStrategyConfig,
  type StrategyAction,
} from '@cat-cafe/shared';
import { type ResolvedContextCapacity, resolveContextCapacity } from '../../../../../config/context-capacity.js';
import { getSessionStrategy, shouldTakeAction } from '../../../../../config/session-strategy.js';
import type { ISessionSealer } from '../../session/SessionSealer.js';
import type { ISessionChainStore } from '../../stores/ports/SessionChainStore.js';
import type { AgentContextCapability, AgentService, TokenUsage } from '../../types.js';
import { resolveContextLifecycleSupport } from '../context-lifecycle-capability.js';

const UNRESOLVED_CAPABILITY: AgentContextCapability = {
  provider: 'unknown',
  carrier: 'unknown',
  reportsRuntimeWindow: false,
  authoritativeUsage: false,
  usageTelemetry: 'unavailable',
  nativeWindowControl: false,
  nativeCompressionControl: false,
  observesCompression: false,
  reason: 'service did not declare a concrete context capability',
};

export interface InvocationCapacitySnapshot {
  readonly capacity: ResolvedContextCapacity;
  readonly capability: AgentContextCapability;
}

export interface AuthoritativeContextUsage {
  readonly usedTokens: number;
  readonly usedFrom: 'context' | 'last_turn';
}

/** Fail closed: aggregate input/total counters are never current-context evidence. */
export function resolveAuthoritativeContextUsage(
  usage: TokenUsage,
  capability: AgentContextCapability,
): AuthoritativeContextUsage | undefined {
  if (!capability.authoritativeUsage) return undefined;
  if (usage.contextUsedTokens != null && Number.isFinite(usage.contextUsedTokens) && usage.contextUsedTokens > 0) {
    return { usedTokens: usage.contextUsedTokens, usedFrom: 'context' };
  }
  if (
    usage.isCumulativeUsage !== true &&
    usage.lastTurnInputTokens != null &&
    Number.isFinite(usage.lastTurnInputTokens) &&
    usage.lastTurnInputTokens > 0
  ) {
    return { usedTokens: usage.lastTurnInputTokens, usedFrom: 'last_turn' };
  }
  return undefined;
}

/** Apply a trusted carrier report to this invocation only. Manual mode remains literal. */
export function applyReportedWindowToInvocationSnapshot(options: {
  snapshot: InvocationCapacitySnapshot;
  catId: CatId | string;
  reportedWindowSize?: number;
}): InvocationCapacitySnapshot {
  const { snapshot, catId, reportedWindowSize } = options;
  if (!snapshot.capability.reportsRuntimeWindow || reportedWindowSize == null) return snapshot;
  const config = catRegistry.tryGet(catId)?.config;
  return {
    ...snapshot,
    capacity: resolveContextCapacity({
      catId,
      reportedWindowSize,
      model: config?.defaultModel,
    }),
  };
}

/** Read the current member configuration once for one invocation. */
export function resolveInvocationCapacitySnapshot(options: {
  catId: CatId | string;
  service: AgentService;
  reportedWindowSize?: number;
}): InvocationCapacitySnapshot {
  const { catId, service, reportedWindowSize } = options;
  const config = catRegistry.tryGet(catId)?.config;
  const capability = service.contextCapability?.() ?? UNRESOLVED_CAPABILITY;
  return {
    capacity: resolveContextCapacity({
      catId,
      reportedWindowSize: capability.reportsRuntimeWindow ? reportedWindowSize : undefined,
      model: config?.defaultModel,
    }),
    capability,
  };
}

/**
 * Re-evaluate a stored authoritative usage observation against the member's
 * current invocation ceiling. This lets a manual decrease seal an already-full
 * session before the provider is called again.
 */
export function resolvePreInvocationCapacityAction(options: {
  snapshot: InvocationCapacitySnapshot;
  contextHealth: ContextHealth | undefined;
  compressionCount: number;
  strategy: SessionStrategyConfig;
}): StrategyAction {
  const { snapshot, contextHealth, compressionCount, strategy } = options;
  const inputCeiling = snapshot.capacity.inputCeilingTokens;
  if (
    !snapshot.capacity.actionable ||
    inputCeiling <= 0 ||
    contextHealth?.source !== 'exact' ||
    (contextHealth.usedFrom !== 'context' && contextHealth.usedFrom !== 'last_turn')
  ) {
    return { type: 'none' };
  }

  const support = resolveContextLifecycleSupport(snapshot.capability, strategy.strategy);
  const effectiveStrategy = support.supported ? strategy : { ...strategy, strategy: 'handoff' as const };
  const fillRatio = Math.min(contextHealth.usedTokens / inputCeiling, 1);
  return shouldTakeAction(fillRatio, inputCeiling, contextHealth.usedTokens, compressionCount, effectiveStrategy);
}

/**
 * Seal an active session before provider launch when the member's newly-read
 * ceiling is already exhausted by the last authoritative usage observation.
 */
export async function sealBeforeInvocationIfNeeded(options: {
  snapshot: InvocationCapacitySnapshot;
  catId: CatId;
  threadId: string;
  sessionChainStore: ISessionChainStore | undefined;
  sessionSealer: ISessionSealer | undefined;
  clearProviderSession: () => Promise<void>;
}): Promise<boolean> {
  const { snapshot, catId, threadId, sessionChainStore, sessionSealer, clearProviderSession } = options;
  if (!sessionChainStore || !sessionSealer) return false;

  const active = await sessionChainStore.getActive(catId, threadId);
  if (!active) return false;

  const action = resolvePreInvocationCapacityAction({
    snapshot,
    contextHealth: active.contextHealth,
    compressionCount: active.compressionCount ?? 0,
    strategy: getSessionStrategy(catId),
  });
  if (action.type !== 'seal' && action.type !== 'seal_after_compress') return false;

  const result = await sessionSealer.requestSeal({ sessionId: active.id, reason: action.reason });
  if (!result.accepted) return false;

  await clearProviderSession();
  await sessionSealer.finalize({ sessionId: active.id });
  return true;
}
