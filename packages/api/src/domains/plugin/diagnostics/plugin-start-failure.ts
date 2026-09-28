import type { Capability } from '@clowder-ai/plugin-contract';
import { createModuleLogger } from '../../../infrastructure/logger.js';
import { ExternalPluginRuntimeError } from '../external-runtime/types.js';
import type { PluginRuntimeErrorDetail, PluginRuntimeErrorRecord } from '../host-inventory/types.js';
import { refusedHostCapability } from '../host-surface/host-capability-refusal.js';
import { type SafeErrorProjection, safeErrorProjection } from './safe-error-projection.js';

/** F202 W2-6b — where a runtime start was attempted when it failed. */
export type PluginStartPhase =
  | 'enable'
  | 'repair'
  | 'restart_resume'
  | 'maintenance_resume'
  | 'maintenance_rollback_resume';

/** What the Host can vouch for about a failed start; anything else stays unclassified. */
export type PluginStartFailureCategory =
  | { readonly kind: 'capability_not_granted'; readonly capability: Capability }
  | { readonly kind: 'host_runtime_error'; readonly code: string }
  | { readonly kind: 'unclassified' };

/** A failed start as the Host log receives it: never the raw error, only its safe projection. */
export interface PluginStartFailureReport {
  readonly pluginId: string;
  readonly pluginInstanceId: string;
  readonly phase: PluginStartPhase;
  /** Also the `occurredAt` of the failure recorded on the instance, so the two can be matched. */
  readonly occurredAt: number;
  readonly category: PluginStartFailureCategory;
  readonly error: SafeErrorProjection;
}

export type PluginStartFailureObserver = (report: PluginStartFailureReport) => void;

function hostRuntimeErrorCode(error: unknown): string | undefined {
  try {
    if (!(error instanceof ExternalPluginRuntimeError)) return undefined;
    const { code } = error;
    return typeof code === 'string' && /^[A-Z][A-Z_]{0,47}$/u.test(code) ? code : undefined;
  } catch {
    return undefined;
  }
}

export function classifyStartFailure(error: unknown): PluginStartFailureCategory {
  const capability = refusedHostCapability(error);
  if (capability !== undefined) return { kind: 'capability_not_granted', capability };
  const code = hostRuntimeErrorCode(error);
  return code === undefined ? { kind: 'unclassified' } : { kind: 'host_runtime_error', code };
}

export function pluginStartFailureReport(input: {
  readonly pluginId: string;
  readonly pluginInstanceId: string;
  readonly phase: PluginStartPhase;
  readonly occurredAt: number;
  readonly error: unknown;
}): PluginStartFailureReport {
  return {
    pluginId: input.pluginId,
    pluginInstanceId: input.pluginInstanceId,
    phase: input.phase,
    occurredAt: input.occurredAt,
    category: classifyStartFailure(input.error),
    error: safeErrorProjection(input.error),
  };
}

const log = createModuleLogger('plugin/lifecycle');

/** The Host's default observer: one error line per failed start in the server log. */
export function logPluginStartFailure(report: PluginStartFailureReport): void {
  log.error({ ...report }, 'plugin runtime failed to start');
}

/**
 * The failure a start leaves on the instance. Its code stays `UNEXPECTED_RUNTIME_FAILURE`, which a
 * Host from before W2-6b can read; when the Host refused a capability, the detail beside it says
 * which one.
 */
export function startFailureRecord(
  error: unknown,
  occurredAt: number,
): { readonly record: PluginRuntimeErrorRecord; readonly detail?: PluginRuntimeErrorDetail } {
  const record: PluginRuntimeErrorRecord = {
    code: 'UNEXPECTED_RUNTIME_FAILURE',
    exitCode: null,
    signal: null,
    occurredAt,
  };
  const capability = refusedHostCapability(error);
  return capability === undefined
    ? { record }
    : { record, detail: { kind: 'capability_not_granted', capability, occurredAt } };
}

/** What an owner's enable request is told; the plugin's detail card says what to do about it. */
export function startFailedMessage(detail: PluginRuntimeErrorDetail | undefined): string {
  return detail === undefined
    ? 'official plugin runtime failed to start'
    : `official plugin runtime failed to start: the Host refused it ${detail.capability}`;
}
