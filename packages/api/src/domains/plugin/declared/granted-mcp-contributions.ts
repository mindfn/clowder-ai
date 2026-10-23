import type { PluginManifest } from '@clowder-ai/plugin-contract';

/** Native-action MCP publication and credentials share the owning feature's grant contract. */
export function grantedMcpContributionIds(
  manifest: Pick<PluginManifest, 'features'>,
  effectiveGrants: readonly string[],
): ReadonlySet<string> {
  return new Set(
    manifest.features
      .filter((feature) => feature.capabilities.every((capability) => effectiveGrants.includes(capability)))
      .flatMap((feature) => (feature.contributions ?? []).filter((item) => item.type === 'mcp').map((item) => item.id)),
  );
}
