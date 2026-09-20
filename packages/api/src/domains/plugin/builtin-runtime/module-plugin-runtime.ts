import { pathToFileURL } from 'node:url';

import type { PluginManifest } from '@clowder-ai/plugin-contract';
import { verifyPackageEntrypoint } from '../external-runtime/package-entrypoint-authority.js';
import {
  ExternalPluginRuntimeError,
  type VerifiedPluginPackage,
  type VerifiedPluginPackageLocator,
} from '../external-runtime/types.js';
import type { PluginPackageRecord } from '../host-inventory/types.js';
import type { BundledPluginRuntime } from './bundled-runtime-carrier.js';

/**
 * What the module at `runtime.entrypoint` must export by default.
 *
 * Asserted structurally on purpose. The published SDK does not yet carry
 * `PluginModuleEntrypoint` (F202 Train C1 migration plan §8.8), so the Host pins the
 * shape it actually needs instead of importing a type no artifact ships. When the SDK
 * publishes it, this narrows to that type in one place.
 */
export interface PluginModuleEntrypointShape {
  create(manifest: PluginManifest): unknown;
}

export interface ModulePluginRuntimeOptions {
  readonly packages: VerifiedPluginPackageLocator;
}

interface LoadedModule {
  readonly located: VerifiedPluginPackage;
  readonly plugin: unknown;
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
 * Steps 1 and 2 of §8.6 land here. Step 3 (per-feature activation returning an action
 * table) and step 4 (`FeatureContext`) stay blocked on the SDK release tracked in §8.8,
 * so a loaded package is defined but not yet activated.
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

  async start(pluginInstanceId: string, packageRecord: PluginPackageRecord): Promise<void> {
    if (this.#loaded.has(pluginInstanceId)) {
      throw new ExternalPluginRuntimeError(
        'RUNTIME_ALREADY_ACTIVE',
        `${pluginInstanceId} already has a module loaded in this Host`,
      );
    }
    const located = await this.options.packages.resolveInstalledPackage(packageRecord.packageDigest);
    let plugin: unknown;
    try {
      const { entrypoint } = await verifyPackageEntrypoint(packageRecord, located);
      const namespace = (await import(pathToFileURL(entrypoint).href)) as { default?: unknown };
      const entry = namespace.default;
      if (typeof (entry as PluginModuleEntrypointShape | undefined)?.create !== 'function') {
        throw new ExternalPluginRuntimeError(
          'INVALID_ENTRYPOINT',
          `${packageRecord.pluginId} entrypoint must default-export a module with create()`,
        );
      }
      // The Host hands over the record IT admitted (§8.6 step 2). The authority above
      // already refused a located tree whose manifest differs from that record, so the
      // package cannot smuggle a second truth in; what this adds is that whatever the
      // module reads about itself at runtime is not what the Host acts on.
      plugin = (entry as PluginModuleEntrypointShape).create(packageRecord.manifest);
    } catch (error) {
      await located.release().catch(() => undefined);
      throw error;
    }
    this.#loaded.set(pluginInstanceId, { located, plugin });
  }

  /**
   * The Host's single disposal seam for a loaded module. Stop, owner disable, uninstall
   * and start-failure rollback all arrive here through the carrier, so the staged package
   * is released and the next start calls `create()` again rather than reusing whatever the
   * previous run left behind (§8.6 step 5).
   *
   * Node keeps the module namespace itself cached per URL, which is why the SDK's shape is
   * a `create()` factory rather than module-level state: the instance is per-start even
   * though the module is loaded once.
   */
  async stop(pluginInstanceId: string, _reason: string): Promise<void> {
    const loaded = this.#loaded.get(pluginInstanceId);
    if (!loaded) return;
    this.#loaded.delete(pluginInstanceId);
    await loaded.located.release();
  }

  /**
   * What `create()` returned, while the instance is loaded — the package's live in-Host
   * instance. The activation slice consumes it once the SDK publishes per-feature
   * activation (§8.8 step 3); until then it is how "the Host is holding this package"
   * stays observable rather than implied.
   */
  definedPlugin(pluginInstanceId: string): unknown {
    return this.#loaded.get(pluginInstanceId)?.plugin;
  }
}
