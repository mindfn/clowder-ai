import { validatePluginCatalog } from '@clowder-ai/plugin-contract';
import { OFFICIAL_BUNDLED_CATALOG_ENTRIES, OFFICIAL_PLUGIN_POLICIES } from '../official-catalog.js';
import {
  loadMachinePluginCatalog,
  type MachineCatalogHostPolicy,
  MachineOfficialPluginCatalog,
  OFFICIAL_PLUGIN_CATALOG_URL,
} from './machine-catalog-provider.js';

/** Host authority used by both discovery and repository replacement in main(). */
export const PLUGIN_MANAGER_HOST_POLICIES: readonly MachineCatalogHostPolicy[] = [
  // The plugin repository supplies release coordinates; this grants no Host capability.
  { pluginId: 'official.tripo-studio', effectiveGrants: [] },
  {
    pluginId: 'dev.clowder.video-analysis',
    replacesRepositoryPluginId: 'video-analysis',
    effectiveGrants: ['plugin.config.read', 'secret.read'],
  },
  // Reuse Companion's existing Host authority; discovery does not grant new capabilities.
  ...OFFICIAL_PLUGIN_POLICIES.filter((policy) => policy.pluginId === 'official.companion'),
];

export function createHostOfficialPluginCatalog(
  loadCatalog: () => Promise<unknown> = () => loadMachinePluginCatalog(OFFICIAL_PLUGIN_CATALOG_URL),
): MachineOfficialPluginCatalog {
  return new MachineOfficialPluginCatalog({
    loadCatalog,
    validateCatalog: validatePluginCatalog,
    hostPolicies: PLUGIN_MANAGER_HOST_POLICIES,
    bundledEntries: OFFICIAL_BUNDLED_CATALOG_ENTRIES,
  });
}
