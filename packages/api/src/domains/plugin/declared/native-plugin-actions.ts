import { randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { type PluginCallContext, withPluginCallContext } from '../carrier/plugin-call-context.js';
import type { PluginRuntimeAdmission } from '../carrier/runtime-carrier.js';

export class NativePluginActionError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

interface Binding {
  readonly instanceId: string;
  readonly token: string;
  readonly admission: PluginRuntimeAdmission;
  readonly methods: ReadonlySet<string>;
  readonly invoke: (method: string, input: unknown) => Promise<unknown>;
}

/** A native MCP transport can call only actions belonging to its current local activation. */
export class NativePluginActions {
  readonly #bindings = new Map<string, Binding>();
  readonly #tokens = new Map<string, Binding>();
  readonly #generations = new Map<string, number>();

  constructor(private readonly admission: (instanceId: string) => Promise<PluginRuntimeAdmission>) {}

  generation(instanceId: string): number {
    if (!this.#generations.has(instanceId)) this.#generations.set(instanceId, 0);
    return this.#generations.get(instanceId) ?? 0;
  }

  activate(admission: PluginRuntimeAdmission, generation: number, invoke: Binding['invoke']): void {
    const instanceId = admission.instance.pluginInstanceId;
    if (generation !== this.generation(instanceId) || this.#bindings.has(instanceId)) {
      throw new NativePluginActionError(409, 'Plugin activation changed during startup');
    }
    const methods = new Set<string>();
    for (const contribution of admission.packageRecord.manifest.contributions ?? []) {
      if (contribution.type === 'tool') {
        methods.add(contribution.action.method);
      }
    }
    const binding: Binding = {
      instanceId,
      token: randomBytes(32).toString('hex'),
      admission: structuredClone(admission),
      methods,
      invoke,
    };
    this.#bindings.set(instanceId, binding);
    this.#tokens.set(binding.token, binding);
  }

  environment(instanceId: string): Readonly<Record<string, string>> {
    const binding = this.#bindings.get(instanceId);
    if (!binding) return {};
    return {
      CLOWDER_PLUGIN_ACTION_TOKEN: binding.token,
      CLOWDER_PLUGIN_ACTION_PATH: '/api/plugin-runtime/action',
    };
  }

  deactivate(instanceId: string): void {
    this.#generations.set(instanceId, this.generation(instanceId) + 1);
    const binding = this.#bindings.get(instanceId);
    if (binding) this.#tokens.delete(binding.token);
    this.#bindings.delete(instanceId);
  }

  deactivateAll(): void {
    for (const id of new Set([...this.#generations.keys(), ...this.#bindings.keys()])) this.deactivate(id);
  }

  async call(token: string, method: string, input: unknown, caller: PluginCallContext): Promise<unknown> {
    const binding = this.#tokens.get(token);
    if (!binding) throw new NativePluginActionError(401, 'Plugin connection is not active');
    if (!binding.methods.has(method)) throw new NativePluginActionError(403, 'Action is not declared by this plugin');
    let finished = false;
    const assertCurrent = async () => {
      await caller.assertCurrent();
      const current = await this.admission(binding.instanceId);
      if (
        finished ||
        this.#bindings.get(binding.instanceId) !== binding ||
        current.instance.activationState !== 'enabled' ||
        current.instance.lifecycleState !== 'installed' ||
        current.instance.configReadiness !== 'ready' ||
        current.instance.packageDigest !== binding.admission.instance.packageDigest ||
        current.instance.lifecycleRevision !== binding.admission.instance.lifecycleRevision ||
        !isDeepStrictEqual([...current.effectiveGrants].sort(), [...binding.admission.effectiveGrants].sort())
      )
        throw new NativePluginActionError(409, 'Plugin call is no longer current');
    };
    const context = Object.freeze({ ...caller, assertCurrent });
    await assertCurrent();
    try {
      const result = await withPluginCallContext(binding.instanceId, context, () => binding.invoke(method, input));
      await assertCurrent();
      return result;
    } finally {
      finished = true;
    }
  }
}
