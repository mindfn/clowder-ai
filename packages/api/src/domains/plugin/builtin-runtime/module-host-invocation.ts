/**
 * F202 Train C1 — the Host→plugin direction over the in-process module carrier.
 *
 * The carrier already holds what a package's `create(manifest)` returned, so calling a method
 * that package declared is a function call on that instance. This is the TypeScript shape of the
 * SPI: no transport, no serialisation, no second lifecycle. Message delivery is one caller of it
 * and holds no special status — a schedule firing or a webhook arriving is the same call with a
 * different declared method.
 *
 * WHY EVERY FAILURE PATH REJECTS. Callers read a resolved promise as "the package accepted this
 * work"; the delivery driver advances its cursor on exactly that signal. A method the package
 * never implemented must therefore reject rather than quietly do nothing, or a message would be
 * recorded as delivered while nobody ever received it.
 *
 * WHY THE NAME IS NOT TRUSTED. The method name comes from a package manifest, so it is
 * attacker-influenced input arriving at a property lookup. `toString`, `constructor`, `valueOf`
 * and `__proto__` all resolve to something callable on any object at all — invoking one would
 * run code the package never wrote and then report success for it. So the lookup walks only the
 * package's own instance and its own classes, stopping before the shared object roots, and a
 * short list of names that are never a package's method is refused outright.
 */

import { ExternalPluginRuntimeError } from '../external-runtime/types.js';
import type { HostInvocationPort } from '../host-invocation.js';

export interface ModuleHostInvocationDeps {
  /** The carrier holding loaded instances; `definedPlugin` returns what `create()` returned. */
  readonly runtime: { definedPlugin(pluginInstanceId: string): unknown };
}

/** Names that are never a package's own method, whatever the prototype chain says. */
const NEVER_A_METHOD = new Set(['constructor', 'prototype', '__proto__']);

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

export function createModuleHostInvocation(deps: ModuleHostInvocationDeps): HostInvocationPort {
  return {
    async invoke(targetId: string, method: string, params: unknown): Promise<void> {
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
      if (NEVER_A_METHOD.has(method)) {
        throw new ExternalPluginRuntimeError(
          'PROTOCOL_VIOLATION',
          `${targetId} declared the reserved name '${method}', which is never a package method`,
        );
      }

      const candidate = resolvePackageMethod(instance as object, method);
      if (typeof candidate !== 'function') {
        throw new ExternalPluginRuntimeError(
          'PROTOCOL_VIOLATION',
          `${targetId} declared '${method}' but its module does not implement it`,
        );
      }

      // Awaited so a rejected promise reaches the caller; the return value is deliberately
      // ignored — acceptance is signalled by not throwing, never by what comes back.
      await (candidate as (input: unknown) => unknown).call(instance, params);
    },
  };
}
