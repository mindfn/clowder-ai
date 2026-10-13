import { isDeepStrictEqual } from 'node:util';
import { snapshotPluginProtocolData } from '../../../../plugin/carrier/plugin-protocol-data.js';
import type { InvocationRecord } from './InvocationRegistry.js';
import { parseToolExecutionPolicy } from './tool-execution-policy.js';

/** Host-derived execution coordinates, never a package-supplied grant or SDK DTO. */
export interface PluginTaskInvocationBinding {
  readonly version: 1;
  readonly pluginInstanceId: string;
  readonly ownerUserId: string;
  readonly taskId: string;
  readonly taskRevision: number;
  readonly targetCatId: string;
  readonly threadId: string;
  readonly admissionRef: string;
  readonly executionRef: string;
  readonly sourceMessageId: string;
  readonly sourceRevision: number;
  /** The Host dispatch message is distinct from the plugin's original durable source. */
  readonly triggerMessageId: string;
  readonly packageDigest: string;
  readonly lifecycleRevision: number;
  readonly grantRevision: number;
}

type Identity = Pick<
  InvocationRecord,
  | 'userId'
  | 'catId'
  | 'threadId'
  | 'ownerAuthProvenance'
  | 'originTriggerMessageId'
  | 'a2aTriggerMessageId'
  | 'managedWorkBinding'
  | 'publicInvocationBinding'
  | 'pluginTaskBinding'
  | 'toolExecutionPolicy'
>;
const strings = [
  'pluginInstanceId',
  'ownerUserId',
  'taskId',
  'targetCatId',
  'threadId',
  'admissionRef',
  'executionRef',
  'sourceMessageId',
  'triggerMessageId',
  'packageDigest',
] as const;
const revisions = ['taskRevision', 'sourceRevision', 'lifecycleRevision', 'grantRevision'] as const;
function refuse(): never {
  throw new Error('Invalid plugin Task invocation binding');
}
function coordinate(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 512 &&
    value.trim() === value &&
    ![...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  );
}
/** Validate durable Host coordinates without inventing an invocation or tool policy. */
export function capturePluginTaskBinding(value: unknown): PluginTaskInvocationBinding {
  try {
    const binding = snapshotPluginProtocolData(value) as PluginTaskInvocationBinding;
    if (
      !binding ||
      typeof binding !== 'object' ||
      Array.isArray(binding) ||
      !isDeepStrictEqual(Object.keys(binding).sort(), ['version', ...strings, ...revisions].sort()) ||
      binding.version !== 1 ||
      !strings.every((k) => coordinate(binding[k])) ||
      !revisions.every((k) => Number.isSafeInteger(binding[k]) && binding[k] >= (k === 'grantRevision' ? 0 : 1)) ||
      !/^message:.+/.test(binding.admissionRef) ||
      !/^message:.+/.test(binding.executionRef) ||
      binding.admissionRef === binding.executionRef ||
      binding.triggerMessageId === binding.sourceMessageId
    )
      refuse();
    return binding;
  } catch {
    return refuse();
  }
}

/** Snapshot and validate before mutation/await, including direct backend callers and Redis decode. */
export function capturePluginTaskInvocationAuth<T extends Identity>(input: T): T {
  if (input.pluginTaskBinding === undefined) return input;
  try {
    const binding = capturePluginTaskBinding(input.pluginTaskBinding);
    const policy = parseToolExecutionPolicy(JSON.stringify(snapshotPluginProtocolData(input.toolExecutionPolicy)));
    if (
      input.userId !== binding.ownerUserId ||
      input.catId !== binding.targetCatId ||
      input.threadId !== binding.threadId ||
      input.originTriggerMessageId !== binding.triggerMessageId ||
      input.ownerAuthProvenance !== 'unknown' ||
      input.managedWorkBinding !== undefined ||
      input.publicInvocationBinding !== undefined ||
      input.a2aTriggerMessageId !== undefined ||
      policy?.mode !== 'plugin_native' ||
      policy.pluginInstanceId !== binding.pluginInstanceId
    )
      refuse();
    return { ...input, pluginTaskBinding: binding, toolExecutionPolicy: snapshotPluginProtocolData(policy) } as T;
  } catch {
    return refuse();
  }
}

/** Only authentication-grade fields participate; trace/claim/terminal telemetry is not authority. */
export function pluginTaskInvocationIdentity(record: InvocationRecord) {
  const value = capturePluginTaskInvocationAuth(record);
  if (!value.pluginTaskBinding) refuse();
  return snapshotPluginProtocolData({
    invocationId: value.invocationId,
    callbackToken: value.callbackToken,
    userId: value.userId,
    catId: value.catId,
    threadId: value.threadId,
    ownerAuthProvenance: value.ownerAuthProvenance,
    originTriggerMessageId: value.originTriggerMessageId,
    pluginTaskBinding: value.pluginTaskBinding,
    toolExecutionPolicy: value.toolExecutionPolicy,
  });
}

/** Credential-free, detached and deeply frozen input for Host Task currentness. */
export function pluginTaskCurrentnessInput(record: InvocationRecord) {
  const value = capturePluginTaskInvocationAuth(record);
  if (!value.pluginTaskBinding) refuse();
  return Object.freeze({
    invocationId: value.invocationId,
    userId: value.userId,
    catId: value.catId,
    threadId: value.threadId,
    ownerAuthProvenance: value.ownerAuthProvenance,
    originTriggerMessageId: value.originTriggerMessageId,
    pluginTaskBinding: value.pluginTaskBinding,
    toolExecutionPolicy: value.toolExecutionPolicy,
  });
}
export type PluginTaskCurrentnessInput = ReturnType<typeof pluginTaskCurrentnessInput>;
