/**
 * F202 Train C1 — the Host→plugin direction over the in-process module carrier.
 *
 * The carrier already holds what a package's `create(manifest)` returned, so the published
 * `host.messaging.deliver` call is a function call on that instance. There is no second wire
 * shape, transport, serialisation path, or lifecycle.
 *
 * WHY EVERY FAILURE PATH REJECTS. Callers read a resolved promise as "the package accepted this
 * work"; the delivery driver advances its cursor on exactly that signal. A method the package
 * never implemented must therefore reject rather than quietly do nothing, or a message would be
 * recorded as delivered while nobody ever received it.
 *
 * The fixed wire method is still resolved only on the package instance and its own classes. A
 * shared object-root property can never stand in for an implemented Host callback.
 */

import {
  type M0CDeliverInput,
  type M0CDeliverResult,
  validateMessagingRowInput,
  validateMessagingRowResult,
} from '@clowder-ai/plugin-contract';
import { ExternalPluginRuntimeError } from '../external-runtime/types.js';
import type { HostMessagingDeliveryPort } from '../host-invocation.js';

export interface ModuleHostInvocationDeps {
  /** The carrier holding loaded instances; `definedPlugin` returns what `create()` returned. */
  readonly runtime: { definedPlugin(pluginInstanceId: string): unknown };
}

const DELIVERY_METHOD = 'host.messaging.deliver';

/**
 * Resolve a method the package itself defines — on the instance or on its own classes — and
 * nothing that merely exists because every JavaScript object inherits it.
 */
function resolvePackageMethod(instance: object, method: string): unknown {
  for (
    let current: object | null = instance;
    current !== null && current !== Object.prototype && current !== Function.prototype;
    current = Object.getPrototypeOf(current) as object | null
  ) {
    if (Object.hasOwn(current, method)) return (current as Record<string, unknown>)[method];
  }
  return undefined;
}

export function createModuleHostInvocation(deps: ModuleHostInvocationDeps): HostMessagingDeliveryPort {
  return {
    async deliver(targetId: string, input: M0CDeliverInput): Promise<M0CDeliverResult> {
      const instance = deps.runtime.definedPlugin(targetId);
      if (instance === undefined || instance === null) {
        throw new ExternalPluginRuntimeError('INSTANCE_NOT_RUNNABLE', `${targetId} has no module loaded in this Host`);
      }
      if (typeof instance !== 'object' && typeof instance !== 'function') {
        throw new ExternalPluginRuntimeError(
          'PROTOCOL_VIOLATION',
          `${targetId} did not produce an instance that can carry methods`,
        );
      }
      const candidate = resolvePackageMethod(instance as object, DELIVERY_METHOD);
      if (typeof candidate !== 'function') {
        throw new ExternalPluginRuntimeError('PROTOCOL_VIOLATION', `${targetId} does not implement ${DELIVERY_METHOD}`);
      }

      const validatedInput = validateMessagingRowInput(DELIVERY_METHOD, input);
      if (!validatedInput.valid) {
        throw new ExternalPluginRuntimeError('PROTOCOL_VIOLATION', `${targetId} received invalid Host delivery input`);
      }
      const result = await (candidate as (value: M0CDeliverInput) => unknown).call(instance, validatedInput.value);
      const validatedResult = validateMessagingRowResult(DELIVERY_METHOD, result);
      if (!validatedResult.valid || validatedResult.value.deliveryId !== validatedInput.value.deliveryId) {
        throw new ExternalPluginRuntimeError('PROTOCOL_VIOLATION', `${targetId} returned an invalid delivery receipt`);
      }
      return validatedResult.value;
    },
  };
}
