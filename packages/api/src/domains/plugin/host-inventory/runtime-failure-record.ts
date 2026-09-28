import type { Capability } from '@clowder-ai/plugin-contract';
import type { PackageAdmissionContractRuntime } from './manifest-verifier.js';
import {
  type PluginInstanceRecord,
  PluginInventoryError,
  type PluginRuntimeErrorDetail,
  type PluginRuntimeErrorRecord,
} from './types.js';

/**
 * F202 W2-6b — a runtime failure and what the Host knows about it are recorded together and cleared
 * together; every writer of `lastRuntimeError` goes through these two, so no detail outlives the
 * failure it explains.
 */
export function withoutRuntimeFailure(instance: PluginInstanceRecord): PluginInstanceRecord {
  const { lastRuntimeError: _error, lastRuntimeErrorDetail: _detail, ...withoutFailure } = instance;
  return withoutFailure;
}

export function withRuntimeFailure(
  instance: PluginInstanceRecord,
  error: PluginRuntimeErrorRecord,
  detail?: PluginRuntimeErrorDetail,
): PluginInstanceRecord {
  return {
    ...withoutRuntimeFailure(instance),
    lastRuntimeError: error,
    ...(detail?.occurredAt === error.occurredAt ? { lastRuntimeErrorDetail: detail } : {}),
  };
}

/** The detail explaining the instance's current failure; none when it explains another. */
export function currentRuntimeErrorDetail(instance: PluginInstanceRecord): PluginRuntimeErrorDetail | undefined {
  const detail = instance.lastRuntimeErrorDetail;
  return detail !== undefined && detail.occurredAt === instance.lastRuntimeError?.occurredAt ? detail : undefined;
}

function corrupt(message: string): never {
  throw new PluginInventoryError('CORRUPT_SNAPSHOT', message);
}

const DETAIL_KEYS = ['capability', 'kind', 'occurredAt'];

/**
 * Reads the detail stored on an instance, if any. Its shape is checked strictly — a malformed one is
 * a corrupt snapshot, like any other field. One that does not explain the stored failure is stale and
 * dropped instead: a diagnostic that no longer applies must not stop the whole inventory from loading.
 */
export function parseRuntimeErrorDetail(
  instance: Readonly<Record<string, unknown>>,
  instanceLabel: string,
  lastRuntimeError: PluginRuntimeErrorRecord | undefined,
  contract: PackageAdmissionContractRuntime,
): PluginRuntimeErrorDetail | undefined {
  const value = instance.lastRuntimeErrorDetail;
  if (value === undefined) return undefined;
  const label = `${instanceLabel}.lastRuntimeErrorDetail`;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) corrupt(`${label} must be an object`);
  const raw = value as Record<string, unknown>;
  const keys = Object.keys(raw).sort();
  if (keys.length !== DETAIL_KEYS.length || keys.some((key, index) => key !== DETAIL_KEYS[index])) {
    corrupt(`${label} has unsupported fields`);
  }
  if (raw.kind !== 'capability_not_granted') corrupt(`${label}.kind has an unsupported value`);
  if (typeof raw.capability !== 'string' || !contract.validateEffectiveGrants([raw.capability])) {
    corrupt(`${label}.capability is not a contract capability`);
  }
  const { occurredAt } = raw;
  if (typeof occurredAt !== 'number' || !Number.isSafeInteger(occurredAt) || occurredAt < 0) {
    corrupt(`${label}.occurredAt must be a non-negative safe integer`);
  }
  if (occurredAt !== lastRuntimeError?.occurredAt) return undefined;
  return { kind: 'capability_not_granted', capability: raw.capability as Capability, occurredAt };
}
