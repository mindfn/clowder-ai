import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { PluginCallContext } from '../carrier/plugin-call-context.js';
import type { PluginOwnerOperationContext } from '../carrier/plugin-owner-operation-context.js';
import type { PluginOwnerRequestContext } from '../carrier/plugin-owner-request-context.js';
import { snapshotPluginProtocolData } from '../carrier/plugin-protocol-data.js';
import { ExternalPluginRuntimeError } from '../external-runtime/types.js';

const coordinate = z.string().min(1).max(512);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const pluginTaskProvenanceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('installed_plugin_policy') }).strict(),
  z
    .object({ kind: z.literal('native_exact_origin'), invocationId: coordinate, originTriggerMessageId: coordinate })
    .strict(),
  z
    .object({
      kind: z.literal('owner_http_write'),
      request: z
        .object({
          kind: z.literal('owner_http'),
          requestId: coordinate,
          transportRequestId: coordinate,
          pluginId: coordinate,
          pluginInstanceId: coordinate,
          userId: coordinate,
          contributionId: coordinate,
          method: coordinate,
          declaredPath: coordinate,
          path: coordinate,
          bodyDigest: digest,
          queryDigest: digest,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('owner_operation_write'),
      request: z
        .object({
          requestId: coordinate,
          operationKey: coordinate,
          actionId: coordinate,
          userId: coordinate,
          pluginInstanceId: coordinate,
        })
        .strict(),
    })
    .strict(),
]);
export type PluginTaskProvenance = z.infer<typeof pluginTaskProvenanceSchema>;
const requests = new WeakMap<object, unknown>();
function refuse(reason: string): never {
  throw new ExternalPluginRuntimeError('DELIVERY_REJECTED', reason);
}
export function taskProvenanceMode(value: PluginTaskProvenance) {
  return value.kind === 'native_exact_origin'
    ? 'native_request'
    : value.kind === 'installed_plugin_policy'
      ? 'plugin_policy'
      : 'owner_request';
}
export function isOwnerTaskRequest(value: PluginTaskProvenance) {
  return value.kind === 'owner_http_write' || value.kind === 'owner_operation_write';
}
/** Bind a single Host call to its immutable operation before any yielding effect. Not a durable retry ledger. */
export function captureTaskRequest(input: {
  owner?: PluginOwnerRequestContext;
  operation?: PluginOwnerOperationContext;
  native?: Pick<PluginCallContext, 'invocationId' | 'originTriggerMessageId'>;
  pluginInstanceId: string;
  userId: string;
  selection?: unknown;
}): PluginTaskProvenance {
  const { owner, operation, native, pluginInstanceId, userId } = input;
  if (Number(Boolean(owner)) + Number(Boolean(operation)) + Number(Boolean(native)) > 1)
    refuse('Mixed Task request authority');
  let value: PluginTaskProvenance;
  const authority = owner ?? operation;
  if (owner) {
    const request = owner.requestIdentity;
    if (
      owner.operation !== 'write' ||
      owner.userId !== userId ||
      !request ||
      request.userId !== userId ||
      request.pluginInstanceId !== pluginInstanceId ||
      request.method === 'GET'
    )
      refuse('Host Task request identity unavailable');
    value = { kind: 'owner_http_write', request };
  } else if (operation) {
    if (operation.userId !== userId || operation.pluginInstanceId !== pluginInstanceId)
      refuse('Host Task request identity unavailable');
    const { requestId, operationKey, actionId } = operation;
    value = { kind: 'owner_operation_write', request: { requestId, operationKey, actionId, userId, pluginInstanceId } };
  } else if (native) {
    if (!native.originTriggerMessageId) refuse('Native Task request has no origin');
    value = {
      kind: 'native_exact_origin',
      invocationId: native.invocationId,
      originTriggerMessageId: native.originTriggerMessageId,
    };
  } else value = { kind: 'installed_plugin_policy' };
  value = pluginTaskProvenanceSchema.parse(value);
  if (authority && input.selection !== undefined) {
    const selected = snapshotPluginProtocolData(input.selection);
    if (requests.has(authority) && !isDeepStrictEqual(requests.get(authority), selected))
      refuse('Host Task request semantics conflict');
    requests.set(authority, selected);
  }
  return snapshotPluginProtocolData(value) as PluginTaskProvenance;
}

/** Validate the structural provenance against the owned receipt coordinates, never a caller-declared basis. */
export function assertTaskProvenance(
  value: PluginTaskProvenance,
  instanceId: string,
  userId: string,
  sourceId: string,
) {
  if (value.kind === 'native_exact_origin' && value.originTriggerMessageId !== sourceId)
    refuse('Task native provenance mismatch');
  if ('request' in value && (value.request.pluginInstanceId !== instanceId || value.request.userId !== userId))
    refuse('Task owner provenance mismatch');
  if (value.kind === 'owner_http_write' && !['POST', 'PUT', 'PATCH', 'DELETE'].includes(value.request.method))
    refuse('Task owner provenance is not a write');
}
