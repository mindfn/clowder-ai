/**
 * #1208 invocation capacity owner.
 *
 * Resolve once before prompt assembly/provider launch, bind the concrete carrier,
 * and apply the active session's shrink-no-expand pin. Consumers receive this
 * immutable snapshot instead of independently rediscovering a window.
 */

import { type CatId, catRegistry, type SessionCapacityPin } from '@cat-cafe/shared';
import {
  applySessionPin,
  type ResolvedContextCapacity,
  resolveContextCapacity,
} from '../../../../../config/context-capacity.js';
import type { ISessionChainStore } from '../../stores/ports/SessionChainStore.js';
import type { AgentContextCapability, AgentService, TokenUsage } from '../../types.js';

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
  readonly pin: SessionCapacityPin;
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

/** Incorporate a trusted runtime window report without allowing a same-binding expansion. */
export async function applyReportedWindowToInvocationSnapshot(options: {
  snapshot: InvocationCapacitySnapshot;
  catId: CatId | string;
  threadId: string;
  reportedWindowSize?: number;
  sessionChainStore?: ISessionChainStore;
}): Promise<InvocationCapacitySnapshot> {
  const { snapshot, catId, threadId, reportedWindowSize, sessionChainStore } = options;
  if (!snapshot.capability.reportsRuntimeWindow || reportedWindowSize == null) return snapshot;
  const key = snapshot.capacity.bindingKey;
  const reported = resolveContextCapacity({
    catId,
    reportedWindowSize,
    model: key.model,
    provider: key.provider,
    client: key.client,
    account: key.account,
    carrier: key.carrier,
  });
  const { effective, pin } = applySessionPin(reported, snapshot.pin);
  if (sessionChainStore) {
    const active = await sessionChainStore.getActive(catId as CatId, threadId);
    if (active) await sessionChainStore.update(active.id, { capacityPin: pin, updatedAt: Date.now() });
  }
  return { ...snapshot, capacity: effective, pin };
}

export async function resolveInvocationCapacitySnapshot(options: {
  catId: CatId | string;
  threadId: string;
  service: AgentService;
  sessionChainStore?: ISessionChainStore;
  reportedWindowSize?: number;
}): Promise<InvocationCapacitySnapshot> {
  const { catId, threadId, service, sessionChainStore, reportedWindowSize } = options;
  const config = catRegistry.tryGet(catId)?.config;
  const capability = service.contextCapability?.() ?? UNRESOLVED_CAPABILITY;
  const resolved = resolveContextCapacity({
    catId,
    reportedWindowSize: capability.reportsRuntimeWindow ? reportedWindowSize : undefined,
    model: config?.defaultModel,
    provider: capability.provider,
    client: config?.clientId,
    account: config?.accountRef,
    carrier: capability.carrier,
  });
  const active = sessionChainStore ? await sessionChainStore.getActive(catId as CatId, threadId) : null;
  const { effective, pin } = applySessionPin(resolved, active?.capacityPin);
  if (sessionChainStore && active && active.capacityPin !== pin) {
    await sessionChainStore.update(active.id, { capacityPin: pin, updatedAt: Date.now() });
  }
  return { capacity: effective, pin, capability };
}
