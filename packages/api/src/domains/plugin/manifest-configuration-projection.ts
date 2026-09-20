/**
 * F202 Train C1 gap C — project manifest-declared configuration into an external runtime's
 * environment.
 *
 * The builtin MCP path already performs exactly this grant-checked projection
 * (manager/builtin-contribution-supervisor.ts:558-585) from a contribution's explicit
 * `environment` bindings. A migrated npm package has no such contribution: it declares plain
 * `configuration` fields and reads them as environment variables, which is why the stdio spawn
 * path needs its own projection rather than a reuse of the contribution one.
 *
 * Three fail-closed rules, in the order a caller hits them:
 *  1. `CLOWDER_` is the Host's protocol namespace on the child (supervisor.ts spawn env). A
 *     manifest field landing there would let a package restate its own Host-issued identity, so
 *     a declared key inside that namespace refuses the projection instead of being overridden.
 *  2. A field is projected only if the instance actually holds the grant its kind requires —
 *     `secret.read` for secrets, `plugin.config.read` otherwise. An ungranted field is skipped,
 *     never read into the child, even when a value is stored.
 *  3. A required field with no effective value refuses the projection: a provider that cannot
 *     authenticate must fail closed rather than start blind.
 */

import type { ConfigurationField, PluginManifest } from '@clowder-ai/plugin-contract';
import { effectivePluginConfigurationValue } from './manager/plugin-configuration-values.js';

/** The environment namespace the Host owns on every spawned child. */
export const HOST_PROTOCOL_ENV_PREFIX = 'CLOWDER_';

export interface PluginRuntimeConfigurationPort {
  readConfig(pluginInstanceId: string, key: string): Promise<unknown>;
  readSecret(pluginInstanceId: string, key: string): Promise<string | undefined>;
}

export type ManifestConfigurationProjectionFailure =
  | { readonly reason: 'protocol_namespace'; readonly key: string }
  | { readonly reason: 'value_unavailable'; readonly key: string; readonly kind: ConfigurationField['kind'] };

export class ManifestConfigurationProjectionError extends Error {
  constructor(readonly failure: ManifestConfigurationProjectionFailure) {
    super(
      failure.reason === 'protocol_namespace'
        ? `configuration key ${failure.key} is inside the ${HOST_PROTOCOL_ENV_PREFIX} protocol namespace and cannot be projected`
        : `required ${failure.kind} ${failure.key} is unavailable`,
    );
    this.name = 'ManifestConfigurationProjectionError';
  }
}

function requiredGrant(field: ConfigurationField): string {
  return field.kind === 'secret' ? 'secret.read' : 'plugin.config.read';
}

export interface ManifestConfigurationProjectionInput {
  readonly pluginInstanceId: string;
  readonly manifest: PluginManifest;
  readonly effectiveGrants: readonly string[];
  readonly configuration: PluginRuntimeConfigurationPort;
}

/**
 * Resolves the environment a verified package may receive on top of the protocol variables.
 * Throws {@link ManifestConfigurationProjectionError} rather than degrading, so a caller can
 * never spawn a child that is missing an authority it declared as required.
 */
export async function projectManifestConfigurationEnv(
  input: ManifestConfigurationProjectionInput,
): Promise<Readonly<Record<string, string>>> {
  const fields = input.manifest.configuration ?? [];
  const grants = new Set(input.effectiveGrants);
  const env: Record<string, string> = {};

  for (const field of fields) {
    if (field.key.startsWith(HOST_PROTOCOL_ENV_PREFIX)) {
      throw new ManifestConfigurationProjectionError({ reason: 'protocol_namespace', key: field.key });
    }
    if (!grants.has(requiredGrant(field))) continue;

    const stored =
      field.kind === 'secret'
        ? await input.configuration.readSecret(input.pluginInstanceId, field.key)
        : await input.configuration.readConfig(input.pluginInstanceId, field.key);
    const value = effectivePluginConfigurationValue(field, stored);
    if (value === undefined || value.length === 0) {
      if (field.required) {
        throw new ManifestConfigurationProjectionError({
          reason: 'value_unavailable',
          key: field.key,
          kind: field.kind,
        });
      }
      continue;
    }
    env[field.key] = value;
  }
  return env;
}
