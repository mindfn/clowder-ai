import { pathToFileURL } from 'node:url';

import type { M0CDeliverInput, M0CDeliverResult, PluginManifest } from '@clowder-ai/plugin-contract';
import { verifyPackageEntrypoint } from '../external-runtime/package-entrypoint-authority.js';
import {
  ExternalPluginRuntimeError,
  type VerifiedPluginPackage,
  type VerifiedPluginPackageLocator,
} from '../external-runtime/types.js';
import type { PluginPackageRecord } from '../host-inventory/types.js';
import {
  type PluginRuntimeConfigurationPort,
  resolveManifestConfiguration,
} from '../manifest-configuration-projection.js';
import type { BundledPluginRuntime } from './bundled-runtime-carrier.js';
import { createModuleHostInvocation } from './module-host-invocation.js';

/**
 * What the module at `runtime.entrypoint` must export by default.
 *
 * Asserted structurally on purpose, and it stays that way. The Host defines the shape it
 * needs and the SDK is published afterwards to wrap it, so importing an SDK type here would
 * invert that direction — the Host would end up depending on the package authors' library.
 * Pinning it structurally keeps the dependency one-way with a single place to check.
 */
export interface PluginModuleEntrypointShape {
  create(manifest: PluginManifest): PluginModuleDefinitionShape;
}

export type ModulePluginLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface ModulePluginHostShape {
  readonly config: { get(key: string): Promise<unknown> };
  readonly secrets: { get(key: string): Promise<string | undefined> };
  readonly log: (level: ModulePluginLogLevel, message: string, fields?: Readonly<Record<string, unknown>>) => void;
}

export interface PluginModuleActivationShape {
  readonly actions: Readonly<Record<string, unknown>>;
  stop(): void | Promise<void>;
}

export interface PluginModuleDefinitionShape {
  start(host: ModulePluginHostShape): PluginModuleActivationShape | Promise<PluginModuleActivationShape>;
}

export interface ModulePluginRuntimeOptions {
  readonly packages: VerifiedPluginPackageLocator;
  readonly configuration: PluginRuntimeConfigurationPort;
  readonly log: ModulePluginHostShape['log'];
}

interface LoadedModule {
  readonly located: VerifiedPluginPackage;
  readonly plugin: PluginModuleDefinitionShape;
  readonly activation: PluginModuleActivationShape;
}

/**
 * Runs a package's own code as a module inside the Host process.
 *
 * This is the other half of `builtin`: the Host-shipped runtimes beside it implement a
 * package the Host itself carries, while this one loads the package's module. Both are
 * in-process, so both live under the same carrier and inherit its authority fence,
 * lifecycle state machine and failure isolation — a second copy of that machinery is
 * exactly the carrier-shaped duplication clause 1 exists to remove.
 *
 * Loading is done here; activation is not. The standard Host delivery adapter can call an
 * already-exposed delivery handler, while per-feature activation remains the step that will
 * produce that handler from the package's declared actions.
 */
export class ModulePluginRuntime implements BundledPluginRuntime {
  readonly #loaded = new Map<string, LoadedModule>();

  constructor(private readonly options: ModulePluginRuntimeOptions) {}

  /**
   * Claims any admitted package that declares a module to load. The claim reads the
   * manifest alone — never a pluginId (clause 6) — so registering this runtime after the
   * Host-shipped ones leaves their narrower claims intact.
   */
  claims(packageRecord: Pick<PluginPackageRecord, 'manifest'>): boolean {
    const { runtime } = packageRecord.manifest;
    return runtime.transport === 'builtin' && typeof runtime.entrypoint === 'string';
  }

  async start(
    pluginInstanceId: string,
    packageRecord: PluginPackageRecord,
    effectiveGrants: readonly string[],
  ): Promise<void> {
    if (this.#loaded.has(pluginInstanceId)) {
      throw new ExternalPluginRuntimeError(
        'RUNTIME_ALREADY_ACTIVE',
        `${pluginInstanceId} already has a module loaded in this Host`,
      );
    }
    const located = await this.options.packages.resolveInstalledPackage(packageRecord.packageDigest);
    let plugin: PluginModuleDefinitionShape;
    let activation: PluginModuleActivationShape | undefined;
    try {
      const { entrypoint } = await verifyPackageEntrypoint(packageRecord, located);
      // This carrier's integrity instant: the bytes are re-snapshotted immediately before
      // they become live code in THIS process. There is no projection window to straddle
      // here the way the child-process carrier has, so the check belongs next to `import()`.
      await located.verifyIntegrity();
      const namespace = (await import(pathToFileURL(entrypoint).href)) as { default?: unknown };
      const entry = namespace.default;
      if (typeof (entry as PluginModuleEntrypointShape | undefined)?.create !== 'function') {
        throw new ExternalPluginRuntimeError(
          'INVALID_ENTRYPOINT',
          `${packageRecord.pluginId} entrypoint must default-export a module with create()`,
        );
      }
      // The Host hands over the record IT admitted. The authority above
      // already refused a located tree whose manifest differs from that record, so the
      // package cannot smuggle a second truth in; what this adds is that whatever the
      // module reads about itself at runtime is not what the Host acts on.
      plugin = (entry as PluginModuleEntrypointShape).create(packageRecord.manifest);
      if ((typeof plugin !== 'object' && typeof plugin !== 'function') || typeof plugin?.start !== 'function') {
        throw new ExternalPluginRuntimeError(
          'INVALID_ENTRYPOINT',
          `${packageRecord.pluginId} create() must return a module with start()`,
        );
      }
      const resolved = await resolveManifestConfiguration({
        pluginInstanceId,
        manifest: packageRecord.manifest,
        effectiveGrants,
        configuration: this.options.configuration,
      });
      const config = new Map(
        resolved.filter((field) => field.kind !== 'secret').map((field) => [field.key, field.value]),
      );
      const secrets = new Map(
        resolved.filter((field) => field.kind === 'secret').map((field) => [field.key, field.value]),
      );
      const candidate = await plugin.start({
        config: { get: async (key) => config.get(key) },
        secrets: { get: async (key) => secrets.get(key) },
        log: this.options.log,
      });
      const stop = (candidate as Partial<PluginModuleActivationShape> | undefined)?.stop;
      const actions = (candidate as Partial<PluginModuleActivationShape> | undefined)?.actions;
      if (
        !candidate ||
        (typeof candidate !== 'object' && typeof candidate !== 'function') ||
        !actions ||
        typeof actions !== 'object' ||
        Array.isArray(actions) ||
        typeof stop !== 'function'
      ) {
        if (typeof stop === 'function') await stop.call(candidate);
        throw new ExternalPluginRuntimeError(
          'INVALID_ENTRYPOINT',
          `${packageRecord.pluginId} start() must return an actions table and stop()`,
        );
      }
      activation = candidate;
    } catch (error) {
      if (activation) await Promise.resolve(activation.stop()).catch(() => undefined);
      await located.release().catch(() => undefined);
      throw error;
    }
    this.#loaded.set(pluginInstanceId, { located, plugin, activation });
  }

  /**
   * The Host's single disposal seam for a loaded module. Stop, owner disable, uninstall
   * and start-failure rollback all arrive here through the carrier, so the staged package
   * is released and the next start calls `create()` again rather than reusing whatever the
   * previous run left behind.
   *
   * Node keeps the module namespace itself cached per URL, which is why the SDK's shape is
   * a `create()` factory rather than module-level state: the instance is per-start even
   * though the module is loaded once.
   */
  async stop(pluginInstanceId: string, _reason: string): Promise<void> {
    const loaded = this.#loaded.get(pluginInstanceId);
    if (!loaded) return;
    this.#loaded.delete(pluginInstanceId);
    try {
      await loaded.activation.stop();
    } finally {
      await loaded.located.release();
    }
  }

  deliver(pluginInstanceId: string, input: M0CDeliverInput): Promise<M0CDeliverResult> {
    return createModuleHostInvocation({ runtime: this }).deliver(pluginInstanceId, input);
  }

  invoke(pluginInstanceId: string, method: string, params: unknown): Promise<unknown> {
    return createModuleHostInvocation({ runtime: this }).invoke(pluginInstanceId, method, params);
  }

  actions(pluginInstanceId: string): Readonly<Record<string, unknown>> | undefined {
    return this.#loaded.get(pluginInstanceId)?.activation.actions;
  }

  /**
   * What `create()` returned, while the instance is loaded — the package's live in-Host
   * instance. This is what the Host→plugin direction calls into: a method the package
   * declared is resolved against this object, which is why the carrier exposes it rather
   * than keeping it private.
   */
  definedPlugin(pluginInstanceId: string): unknown {
    return this.#loaded.get(pluginInstanceId)?.plugin;
  }
}
