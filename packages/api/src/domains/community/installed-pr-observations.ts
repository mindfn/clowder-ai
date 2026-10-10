import { z } from 'zod';
import type { CommunityPrItem } from '../cats/services/stores/ports/CommunityPrStore.js';
import type { SignalTaskItem } from '../memory/ThreadAwareSignalSources.js';
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
const observationTime = z.number().finite().nonnegative();
const headSha = z.string().regex(/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/);
// Deliberate whitelist: plugin-private owner, mode, verdict and delivery fields
// are stripped. They cannot become Host governance inputs through this reader.
const subjectObservationSchema = z.object({
  data: z.object({
    subjectKey: z.string(),
    projection: z
      .object({
        subjectKey: z.string(),
        externalReview: z
          .object({
            currentHeadSha: headSha.nullable(),
            headGeneration: z.number().int().positive(),
            currentHeadObservedAt: observationTime.nullable(),
            ci: z
              .object({
                headSha,
                headGeneration: z.number().int().positive(),
                status: z.enum(['pending', 'pass', 'fail']),
                observedAt: observationTime,
              })
              .nullable(),
          })
          .nullish(),
      })
      .nullable(),
  }),
});

export type PrObservationStatus = z.infer<typeof statusSchema>;
export type PrObservationItem = Omit<CommunityPrItem, 'createdAt'>;
export interface CommunityPrObservations {
  repositories(): Promise<string[]>;
  read(repo: string): Promise<{ items: PrObservationItem[]; status: PrObservationStatus }>;
  refresh(repo: string, restart?: boolean): Promise<z.infer<typeof refreshSchema>>;
}

/** Read-only provider observations for UI and memory signals, never admission authority. */
export class InstalledPrObservations implements CommunityPrObservations {
  constructor(
    private readonly inventory: Pick<PluginInventoryStore, 'snapshot'>,
    private readonly invocation: Pick<HostPluginInvocationPort, 'invoke'>,
    private readonly now: () => number = Date.now,
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

  private async session(expectedInstanceId?: string) {
    const binding = await this.binding();
    if (expectedInstanceId !== undefined && binding.id !== expectedInstanceId)
      throw new Error('GitHub observation task instance changed');
    return async (method: string, params: unknown) => {
      if (JSON.stringify(await this.binding()) !== JSON.stringify(binding))
        throw new Error('GitHub observation instance changed');
      const result = await this.invocation.invoke(binding.id, method, params);
      if (JSON.stringify(await this.binding()) !== JSON.stringify(binding))
        throw new Error('GitHub observation instance changed');
      return result;
    };
  }

  /**
   * Memory signals are observations, not review/merge authorization. Canonical
   * task identity is supplied by the Host, never read from private projections.
   * A stopped collection may leave historical CI: require an active Host wait
   * and an aligned observation made in this registration before reporting pass.
   */
  async taskSignals(task: SignalTaskItem): Promise<{ ciPassed: boolean; merged: boolean } | null> {
    const match = /^pr:([^#]+)#([1-9][0-9]*)$/.exec(task.subjectKey ?? '');
    if (task.kind !== 'pr_tracking' || !match || !repoSchema.safeParse(match[1]).success) return null;
    const repo = repoSchema.parse(match[1]);
    const number = Number(match[2]);
    if (!Number.isSafeInteger(number)) return null;
    const subjectKey = `pr:${repo}#${number}`;
    const wait = task.pluginWait;
    if (wait?.invalidated) return null;
    if (task.status === 'done') {
      const invoke = await this.session(wait?.pluginInstanceId);
      const result = await this.traverse(repo, invoke);
      if (
        result.status.refreshStatus !== 'complete' ||
        !result.status.publishedGeneration ||
        result.status.observedAt === null ||
        result.status.failedSubjects.length > 0
      )
        return null;
      return {
        ciPassed: false,
        merged: result.items.some((item) => item.id === subjectKey && item.state === 'merged'),
      };
    }
    return this.ciSignals(task, subjectKey);
  }

  private async ciSignals(task: SignalTaskItem, subjectKey: string) {
    const none = { ciPassed: false, merged: false };
    const wait = task.pluginWait;
    const checkedAt = this.now();
    const registeredAt = wait?.registration?.registeredAt;
    if (
      !wait ||
      !wait.await ||
      wait.await.generation !== wait.generation ||
      wait.threadId !== task.threadId ||
      wait.catId !== task.ownerCatId ||
      wait.userId !== task.userId ||
      typeof registeredAt !== 'number' ||
      !Number.isFinite(registeredAt) ||
      registeredAt < 0 ||
      registeredAt > checkedAt ||
      (wait.await.expiresAt !== undefined && wait.await.expiresAt <= checkedAt)
    )
      return null;
    const invoke = await this.session(wait.pluginInstanceId);
    const data = subjectObservationSchema.parse(await invoke('github.subject.inspect', { subjectKey, limit: 1 })).data;
    if (data.subjectKey !== subjectKey || (data.projection && data.projection.subjectKey !== subjectKey))
      throw new Error('Invalid PR observation identity');
    const head = data.projection?.externalReview;
    const ci = head?.ci;
    const returnedAt = this.now();
    if (wait.await.expiresAt !== undefined && wait.await.expiresAt <= returnedAt) return null;
    if (!head || !ci || head.currentHeadSha === null || head.currentHeadObservedAt === null) return none;
    return {
      merged: false,
      ciPassed:
        ci.status === 'pass' &&
        ci.headSha === head.currentHeadSha &&
        ci.headGeneration === head.headGeneration &&
        ci.observedAt >= head.currentHeadObservedAt &&
        ci.observedAt >= registeredAt &&
        ci.observedAt <= returnedAt &&
        head.currentHeadObservedAt <= returnedAt,
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
