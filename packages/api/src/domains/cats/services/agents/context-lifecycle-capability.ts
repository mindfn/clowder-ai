import type { AgentContextCapability } from '../types.js';

export type ContextLifecycleStrategy = 'handoff' | 'compress' | 'hybrid';

export interface ContextLifecycleSupport {
  supported: boolean;
  reason: string;
}

/** One fail-closed capability gate shared by the API and invocation runtime. */
export function resolveContextLifecycleSupport(
  capability: AgentContextCapability,
  strategy: ContextLifecycleStrategy,
): ContextLifecycleSupport {
  if (!capability.authoritativeUsage || capability.usageTelemetry !== 'available') {
    return {
      supported: false,
      reason:
        capability.usageTelemetry === 'conditional'
          ? 'Context usage unavailable until this carrier emits authoritative usage telemetry'
          : 'Context usage unavailable for this carrier',
    };
  }
  if (strategy === 'compress' && !capability.nativeCompressionControl) {
    return { supported: false, reason: 'Native compression control is unavailable for this carrier' };
  }
  if (strategy === 'hybrid') {
    if (!capability.nativeCompressionControl) {
      return { supported: false, reason: 'Native compression control is unavailable for this carrier' };
    }
    if (!capability.observesCompression) {
      return { supported: false, reason: 'Native compression events are unavailable for this carrier' };
    }
  }
  return { supported: true, reason: capability.reason };
}
