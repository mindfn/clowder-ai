import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getOwnerUserId } from '../../../../../config/cat-config-loader.js';
import {
  CLOUD_CONVERSATION_PROVIDERS,
  type CloudCatConfigSource,
  resolveCloudConversationCat,
} from '../../cloud-bridge/cloud-conversation-identity.js';
import type { AgentKeyRegistry } from './AgentKeyRegistry.js';
import { type AgentKeySidecarDisposition, ensureAgentKeySidecar } from './AgentKeySidecarProvisioner.js';

/**
 * F202 W2-3 h3c-2 — the agent key of the configured cloud cat, whatever its id (it used to be fixed
 * to `gpt-pro`). The key is issued in the `cloud-conversation` scope, so it is only ever accepted
 * inside the cloud return boundary; and it is never published into the shared local-agent map —
 * the Remote MCP gateway receives a single-entry map in its own scrubbed environment.
 */

/** The one cloud cat the Host served before cloud cats were configurable; its override keeps working. */
const LEGACY_CLOUD_CAT_ID = 'gpt-pro';
const LEGACY_KEY_FILE_ENV = 'CAT_CAFE_GPT_PRO_AGENT_KEY_FILE';
const KEY_FILE_CAT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const NO_LONGER_CLOUD = 'no longer the configured cloud cat';

function expandHomePath(pathValue: string, homeDir: string): string {
  if (pathValue === '~') return homeDir;
  if (pathValue.startsWith('~/')) return join(homeDir, pathValue.slice(2));
  return pathValue;
}

export function resolveCloudCatAgentKeyFile(
  catId: string,
  env: NodeJS.ProcessEnv = process.env,
  homeDir = homedir(),
): string {
  if (!KEY_FILE_CAT_ID.test(catId) || catId.includes('..')) {
    throw new Error(`cloud cat id cannot name a key file: ${JSON.stringify(catId)}`);
  }
  const explicit = catId === LEGACY_CLOUD_CAT_ID ? env[LEGACY_KEY_FILE_ENV]?.trim() : undefined;
  if (explicit) return expandHomePath(explicit, homeDir);
  const dataDir = expandHomePath(env.CAT_CAFE_DATA_DIR?.trim() || join(homeDir, '.cat-cafe'), homeDir);
  return join(dataDir, 'agent-keys', `${catId}.secret`);
}

export interface CloudCatAgentKeySidecarOptions {
  readonly catId: string;
  readonly filePath?: string;
  readonly userId?: string;
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Keeps the cloud cat's key file holding one valid cloud-scoped key. A key found there without that
 * scope (published before scopes existed) is replaced, and the provisioner revokes it with the rest.
 */
export async function ensureCloudCatAgentKeySidecar(
  registry: AgentKeyRegistry,
  options: CloudCatAgentKeySidecarOptions,
): Promise<AgentKeySidecarDisposition> {
  const env = options.env ?? process.env;
  return ensureAgentKeySidecar({
    registry,
    catId: options.catId,
    userId: options.userId?.trim() || getOwnerUserId(env),
    keyFile: options.filePath ?? resolveCloudCatAgentKeyFile(options.catId, env),
    scope: 'cloud-conversation',
  });
}

async function readSecret(file: string): Promise<string | undefined> {
  try {
    const secret = (await readFile(file, 'utf8')).trim();
    return secret.length > 0 ? secret : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Revokes the cloud credentials of every cat that is no longer a configured cloud cat, so a key issued
 * for the cloud boundary never outlives the cat's role there. That covers the cloud-scoped keys, and
 * the key the gpt-pro sidecar published before keys carried a scope (found through its key file).
 * Returns the revoked key ids; running it again revokes nothing new.
 */
export async function revokeStaleCloudCatKeys(
  registry: AgentKeyRegistry,
  options: { readonly cloudCatIds: readonly string[]; readonly env?: NodeJS.ProcessEnv; readonly homeDir?: string },
): Promise<string[]> {
  const current = new Set(options.cloudCatIds);
  const revoked: string[] = [];
  for (const record of await registry.list({})) {
    if (record.scope !== 'cloud-conversation' || current.has(record.catId)) continue;
    if (await registry.revoke(record.agentKeyId, NO_LONGER_CLOUD)) revoked.push(record.agentKeyId);
  }
  if (!current.has(LEGACY_CLOUD_CAT_ID)) {
    const file = resolveCloudCatAgentKeyFile(LEGACY_CLOUD_CAT_ID, options.env ?? process.env, options.homeDir);
    const secret = await readSecret(file);
    const verified = secret ? await registry.verify(secret) : undefined;
    if (verified?.ok && verified.record.catId === LEGACY_CLOUD_CAT_ID) {
      if (await registry.revoke(verified.record.agentKeyId, NO_LONGER_CLOUD)) revoked.push(verified.record.agentKeyId);
    }
  }
  return revoked;
}

export interface CloudCatAgentKeyReconciliation {
  readonly registry: AgentKeyRegistry;
  readonly cats: CloudCatConfigSource;
  readonly env?: NodeJS.ProcessEnv;
  readonly log: { info(message: string): void; warn(message: string): void };
}

/**
 * Brings the credentials in line with the cat configuration, at startup and on every renewal tick: the
 * resolved cloud cat of each provider holds its cloud key; a provider with no cat, or with more than
 * one, holds none; every other cloud key is revoked. A failure is logged, never thrown — it disables
 * the cloud path, not the Host.
 */
export async function reconcileCloudCatAgentKeys(input: CloudCatAgentKeyReconciliation): Promise<void> {
  const cloudCatIds: string[] = [];
  for (const provider of new Set(Object.values(CLOUD_CONVERSATION_PROVIDERS))) {
    const resolved = resolveCloudConversationCat(input.cats, provider);
    if (resolved.status === 'ambiguous') {
      input.log.warn(
        `[api] cloud cat for ${provider} is ambiguous (${resolved.catIds.join(', ')}); ` +
          'configure exactly one — its cloud credential stays disabled until then',
      );
      continue;
    }
    if (resolved.status !== 'resolved') continue;
    cloudCatIds.push(resolved.catId);
    try {
      const disposition = await ensureCloudCatAgentKeySidecar(input.registry, {
        catId: resolved.catId,
        ...(input.env === undefined ? {} : { env: input.env }),
      });
      input.log.info(
        `[api] cloud cat ${resolved.catId} agent-key sidecar ${disposition.kind} (${disposition.agentKeyId})`,
      );
    } catch (error) {
      input.log.warn(
        `[api] cloud cat ${resolved.catId} agent-key sidecar failed (cloud MCP disabled): ${String(error)}`,
      );
    }
  }
  try {
    const revoked = await revokeStaleCloudCatKeys(input.registry, {
      cloudCatIds,
      ...(input.env === undefined ? {} : { env: input.env }),
    });
    if (revoked.length > 0) input.log.info(`[api] revoked ${revoked.length} cloud agent key(s) of a former cloud cat`);
  } catch (error) {
    input.log.warn(`[api] revoking stale cloud agent keys failed: ${String(error)}`);
  }
}
