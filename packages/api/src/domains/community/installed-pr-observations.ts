import { z } from 'zod';
import type { CommunityPrItem } from '../cats/services/stores/ports/CommunityPrStore.js';
import type { HostPluginInvocationPort } from '../plugin/carrier/host-invocation.js';
import type { PluginInventoryStore } from '../plugin/host-inventory/ports.js';

const repoSchema = z
  .string()
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/)
  .transform((value) => value.toLowerCase());
const generation = z.string().max(100).nullable();
const failedSubjects = z.array(z.number().int().positive()).max(5000);
const statusSchema = z.object({
  publishedGeneration: generation,
  observedAt: z.number().finite().nonnegative().nullable(),
  refreshStatus: z.enum(['never', 'complete', 'incomplete', 'failed', 'limit_exceeded']),
  failedSubjects,
});
const rowSchema = z.object({
  repo: repoSchema,
  number: z.number().int().positive(),
  subjectKey: z.string(),
  title: z.string().max(1024),
  author: z.string().max(100),
  state: z.enum(['open', 'closed', 'merged']),
  replyState: z.enum(['unreplied', 'replied', 'has-new-activity']),
  headSha: z.string().regex(/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/),
  lastReviewedSha: z
    .string()
    .regex(/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/)
    .nullable(),
  draft: z.boolean(),
  updatedAt: z.number().finite().nonnegative(),
});
const pageSchema = statusSchema.extend({
  items: z.array(rowSchema).max(100),
  nextAfter: z.string().max(160).nullable(),
});
const refreshSchema = z.object({
  status: z.enum(['complete', 'incomplete', 'failed', 'limit_exceeded']),
  complete: z.boolean(),
  hasMore: z.boolean(),
  restartRequired: z.boolean().optional(),
  stagedCount: z.number().int().nonnegative().optional(),
  publishedGeneration: generation,
  observedAt: z.number().finite().nonnegative().nullable().optional(),
  failedSubjects,
});

export type PrObservationStatus = z.infer<typeof statusSchema>;
export type PrObservationItem = Omit<CommunityPrItem, 'createdAt'>;
export interface CommunityPrObservations {
  repositories(): Promise<string[]>;
  read(repo: string): Promise<{ items: PrObservationItem[]; status: PrObservationStatus }>;
  refresh(repo: string, restart?: boolean): Promise<z.infer<typeof refreshSchema>>;
}

/** UI observations only. This adapter never supplies proof or admission authority. */
export class InstalledPrObservations implements CommunityPrObservations {
  constructor(
    private readonly inventory: Pick<PluginInventoryStore, 'snapshot'>,
    private readonly invocation: Pick<HostPluginInvocationPort, 'invoke'>,
  ) {}

  private async binding() {
    const snapshot = await this.inventory.snapshot();
    const instances = snapshot.instances.filter(
      (item) => item.pluginId === 'official.github-operations' && item.lifecycleState === 'installed',
    );
    const instance = instances.length === 1 ? instances[0] : undefined;
    if (!instance || instance.activationState !== 'enabled' || instance.configReadiness !== 'ready')
      throw new Error('GitHub observations plugin is unavailable');
    const grant = snapshot.grants.find((item) => item.pluginInstanceId === instance.pluginInstanceId);
    return {
      id: instance.pluginInstanceId,
      digest: instance.packageDigest,
      revision: instance.lifecycleRevision,
      grants: grant?.grantRevision,
    };
  }

  private async session() {
    const binding = await this.binding();
    return async (method: string, params: unknown) => {
      if (JSON.stringify(await this.binding()) !== JSON.stringify(binding))
        throw new Error('GitHub observation instance changed');
      const result = await this.invocation.invoke(binding.id, method, params);
      if (JSON.stringify(await this.binding()) !== JSON.stringify(binding))
        throw new Error('GitHub observation instance changed');
      return result;
    };
  }

  async refresh(repo: string, restart = false) {
    const invoke = await this.session();
    const result = z.object({ data: refreshSchema }).parse(
      await invoke('github.pull-requests.refresh', {
        repo: repoSchema.parse(repo),
        ...(restart ? { restart: true } : {}),
      }),
    );
    if (result.data.complete !== (result.data.status === 'complete')) throw new Error('Invalid PR refresh status');
    return result.data;
  }

  async repositories() {
    const invoke = await this.session();
    const result = z
      .object({ data: z.object({ pullRequestRepositories: z.array(z.object({ repo: repoSchema })).max(5000) }) })
      .parse(await invoke('github.repository.list', {}));
    return [...new Set(result.data.pullRequestRepositories.map((item) => item.repo))].sort();
  }

  async read(value: string) {
    const repo = repoSchema.parse(value),
      invoke = await this.session();
    // One bounded restart handles a publication racing an existing cursor. Never merge generations.
    for (let traversal = 0; traversal < 2; traversal++) {
      try {
        return await this.traverse(repo, invoke);
      } catch (error) {
        if (traversal === 0 && error instanceof Error && error.message.includes('stale or invalid PR cursor')) continue;
        throw error;
      }
    }
    throw new Error('PR observation generation changed repeatedly');
  }

  private async traverse(repo: string, invoke: (method: string, params: unknown) => Promise<unknown>) {
    const items: PrObservationItem[] = [],
      seen = new Set<string>(),
      cursors = new Set<string>();
    let prAfter: string | undefined, status: PrObservationStatus | undefined;
    for (let page = 0; page < 50; page++) {
      const result = z
        .object({ data: z.object({ pullRequests: pageSchema }) })
        .parse(await invoke('github.repository.observations', { repo, limit: 100, ...(prAfter ? { prAfter } : {}) }))
        .data.pullRequests;
      if (status && status.publishedGeneration !== result.publishedGeneration)
        throw new Error('stale or invalid PR cursor');
      status = statusSchema.parse(result);
      items.push(...projectRows(repo, result.items, seen));
      if (result.nextAfter === null) return { items, status };
      if (!result.publishedGeneration || result.items.length === 0 || cursors.has(result.nextAfter))
        throw new Error('Invalid PR observation cursor');
      cursors.add(result.nextAfter);
      prAfter = result.nextAfter;
    }
    throw new Error('PR observation traversal exceeded its bound');
  }
}

function projectRows(repo: string, rows: z.infer<typeof rowSchema>[], seen: Set<string>): PrObservationItem[] {
  return rows.map(({ number, subjectKey, ...row }) => {
    if (row.repo !== repo || subjectKey !== `pr:${repo}#${number}` || seen.has(subjectKey))
      throw new Error('Invalid PR observation identity');
    seen.add(subjectKey);
    return { ...row, id: subjectKey, prNumber: number };
  });
}
