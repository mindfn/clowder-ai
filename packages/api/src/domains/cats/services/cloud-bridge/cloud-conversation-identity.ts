import { type AgentKeyScope, type CatConfig, type CatId, createCatId } from '@cat-cafe/shared';
import type { CloudConversationHostContribution } from '@clowder-ai/plugin-contract';

/** A cloud-conversation provider as the plugin contract names it. */
export type CloudConversationProvider = CloudConversationHostContribution['provider'];

/**
 * F202 W2-3 h3c-2 — the Host's one table joining the cat provider of a cloud cat (the Host's own
 * cat configuration) to the contract provider its conversations run through. Which cat that is comes
 * from the cat configuration alone: never from a package, never from a literal id. Every place on the
 * cloud cat's active path — dispatch prompt, credentials, callback principal, reply ingest — asks this
 * module, so they cannot disagree about who the cloud cat is.
 */
export const CLOUD_CONVERSATION_PROVIDERS: Readonly<Record<string, CloudConversationProvider>> = Object.freeze({
  'openai-chatgpt-pro': 'chatgpt',
});

export interface CloudCatConfigSource {
  getAllConfigs(): Record<string, Pick<CatConfig, 'provider'>>;
}

/**
 * - `unavailable`: no cat is configured for the provider — it cannot be used and is not polled;
 * - `resolved`: exactly one cat;
 * - `ambiguous`: more than one — the provider's operations are refused (only this provider's).
 */
export type CloudConversationCat =
  | { readonly status: 'unavailable' }
  | { readonly status: 'resolved'; readonly catId: CatId }
  | { readonly status: 'ambiguous'; readonly catIds: readonly CatId[] };

type CatConfigs = Record<string, Pick<CatConfig, 'provider'>>;

function configsOf(source: CloudCatConfigSource): CatConfigs {
  try {
    return source.getAllConfigs();
  } catch {
    return {};
  }
}

function providerIn(configs: CatConfigs, catId: string): CloudConversationProvider | undefined {
  const provider = configs[catId]?.provider;
  return provider !== undefined && Object.hasOwn(CLOUD_CONVERSATION_PROVIDERS, provider)
    ? CLOUD_CONVERSATION_PROVIDERS[provider]
    : undefined;
}

function resolveIn(configs: CatConfigs, provider: CloudConversationProvider): CloudConversationCat {
  const catIds = Object.keys(configs)
    .filter((catId) => providerIn(configs, catId) === provider)
    .map((catId) => createCatId(catId))
    .sort();
  if (catIds.length === 0) return { status: 'unavailable' };
  if (catIds.length === 1) return { status: 'resolved', catId: catIds[0] as CatId };
  return { status: 'ambiguous', catIds };
}

function isResolvedIn(configs: CatConfigs, catId: string): boolean {
  const provider = providerIn(configs, catId);
  if (provider === undefined) return false;
  const resolved = resolveIn(configs, provider);
  return resolved.status === 'resolved' && resolved.catId === catId;
}

/** The contract provider this cat converses through, if it is a cloud cat. */
export function cloudConversationProviderOf(
  source: CloudCatConfigSource,
  catId: string,
): CloudConversationProvider | undefined {
  return providerIn(configsOf(source), catId);
}

export function resolveCloudConversationCat(
  source: CloudCatConfigSource,
  provider: CloudConversationProvider,
): CloudConversationCat {
  return resolveIn(configsOf(source), provider);
}

/** Whether `catId` is, right now, the one resolved cloud cat of its provider. */
export function isResolvedCloudConversationCat(source: CloudCatConfigSource, catId: string): boolean {
  return isResolvedIn(configsOf(source), catId);
}

/**
 * Where an agent-key principal stands against the cloud return boundary, by today's configuration:
 * - `cloud`: its cat is the resolved cloud cat of its provider. Every key of that cat is held to the
 *   cloud boundary — including one issued before keys carried a scope;
 * - `refused`: the key belongs to the cloud boundary — it was issued in the `cloud-conversation`
 *   scope, or its cat is configured with a cloud provider — but its cat is not the resolved cloud cat
 *   now: renamed, moved to another provider, or its provider is ambiguous. Such a key is honoured
 *   nowhere; it never turns into an ordinary key (astra `…000188`, negative case 1);
 * - `ordinary`: any other key.
 */
export type CloudPrincipalStanding = 'cloud' | 'refused' | 'ordinary';

export function cloudPrincipalStanding(
  source: CloudCatConfigSource,
  principal: { readonly catId: string; readonly scope: AgentKeyScope },
): CloudPrincipalStanding {
  const configs = configsOf(source);
  if (isResolvedIn(configs, principal.catId)) return 'cloud';
  if (principal.scope === 'cloud-conversation' || providerIn(configs, principal.catId) !== undefined) return 'refused';
  return 'ordinary';
}
