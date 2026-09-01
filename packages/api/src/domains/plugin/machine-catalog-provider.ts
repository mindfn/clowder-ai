import type { PluginDescription, PluginIconSpec } from '@cat-cafe/shared';
import type { Capability } from '@clowder-ai/plugin-contract';
import type { OfficialPluginCatalogEntry, OfficialPluginOwnerAuth } from './official-catalog.js';
import type { OfficialPluginCatalogProvider, OfficialPluginCatalogSnapshot } from './official-catalog-provider.js';

/**
 * Projection of a catalog after the exact plugin-contract validator accepted it.
 * This boundary deliberately does not validate or duplicate catalog constraints.
 */
interface ValidatedMachineCatalog {
  readonly plugins: readonly {
    readonly pluginId: string;
    readonly name: string;
    readonly description: PluginDescription;
    readonly icon: PluginIconSpec;
    readonly publisher: { readonly name: string };
    readonly versions: readonly {
      readonly version: string;
      readonly artifact: {
        readonly packageName: string;
        readonly tarballUrl: string;
        readonly integrity: string;
      };
    }[];
  }[];
}

export type MachineCatalogValidationResult =
  | { readonly valid: true; readonly catalog: ValidatedMachineCatalog }
  | { readonly valid: false; readonly errors: readonly unknown[] };

export interface MachineCatalogHostPolicy {
  readonly pluginId: string;
  readonly effectiveGrants: readonly Capability[];
  readonly ownerAuth?: OfficialPluginOwnerAuth;
}

export interface MachineOfficialPluginCatalogOptions {
  readonly loadCatalog: () => Promise<unknown>;
  /** Exact runtime export from the selected @clowder-ai/plugin-contract artifact. */
  readonly validateCatalog: (value: unknown) => MachineCatalogValidationResult;
  /** Host-owned authority; catalog metadata is never allowed to widen this policy. */
  readonly hostPolicies: readonly MachineCatalogHostPolicy[];
  readonly now?: () => number;
}

function projectEntry(
  plugin: ValidatedMachineCatalog['plugins'][number],
  policy: MachineCatalogHostPolicy,
): OfficialPluginCatalogEntry | undefined {
  const release = plugin.versions[0];
  if (!release) return undefined;
  return {
    catalogId: plugin.pluginId,
    pluginId: plugin.pluginId,
    packageName: release.artifact.packageName,
    version: release.version,
    archiveUrl: release.artifact.tarballUrl,
    packageDigest: release.artifact.integrity,
    effectiveGrants: policy.effectiveGrants,
    ...(policy.ownerAuth === undefined ? {} : { ownerAuth: policy.ownerAuth }),
    presentation: {
      displayName: plugin.name,
      description: plugin.description,
      icon: plugin.icon,
      publisher: plugin.publisher.name,
    },
  };
}

/** Consumes canonical machine catalog truth without turning it into Host authority. */
export class MachineOfficialPluginCatalog implements OfficialPluginCatalogProvider {
  private readonly now: () => number;
  private readonly policies: ReadonlyMap<string, MachineCatalogHostPolicy>;
  private lastGoodEntries: readonly OfficialPluginCatalogEntry[] = [];

  constructor(private readonly options: MachineOfficialPluginCatalogOptions) {
    this.now = options.now ?? Date.now;
    this.policies = new Map(options.hostPolicies.map((policy) => [policy.pluginId, policy]));
  }

  async snapshot(): Promise<OfficialPluginCatalogSnapshot> {
    const checkedAt = this.now();
    let raw: unknown;
    try {
      raw = await this.options.loadCatalog();
    } catch {
      return {
        entries: this.lastGoodEntries,
        status: 'degraded',
        checkedAt,
        errorCode: 'CATALOG_FETCH_FAILED',
      };
    }

    const validation = this.options.validateCatalog(raw);
    if (!validation.valid) {
      return {
        entries: this.lastGoodEntries,
        status: 'degraded',
        checkedAt,
        errorCode: 'CATALOG_CONTRACT_INVALID',
      };
    }

    const entries: OfficialPluginCatalogEntry[] = [];
    let missingPolicy = false;
    for (const plugin of validation.catalog.plugins) {
      const policy = this.policies.get(plugin.pluginId);
      if (!policy) {
        missingPolicy = true;
        continue;
      }
      const entry = projectEntry(plugin, policy);
      if (entry) entries.push(entry);
    }
    if (missingPolicy || entries.length !== validation.catalog.plugins.length) {
      return {
        entries: this.lastGoodEntries,
        status: 'degraded',
        checkedAt,
        errorCode: 'CATALOG_POLICY_MISSING',
      };
    }
    this.lastGoodEntries = entries;
    return { entries, status: 'fresh', checkedAt };
  }
}
