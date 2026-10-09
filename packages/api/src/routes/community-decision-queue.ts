/**
 * F168 Phase E — Community decision queue routes.
 *
 * GET  /api/community-decision-queue?repo=xxx → prioritized decision queue
 * GET  /api/community-findings                → reconciliation/SLA findings
 * POST /api/community-findings/:id/acknowledge
 * POST /api/community-findings/:id/resolve
 * POST /api/community-findings/:id/waive
 */

import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ICommunityIssueStore } from '../domains/cats/services/stores/ports/CommunityIssueStore.js';
import type { ITaskStore } from '../domains/cats/services/stores/ports/TaskStore.js';
import type { ICommunityObjectStore } from '../domains/community/CommunityObjectStore.js';
import { buildCommunityDecisionQueue } from '../domains/community/community-decision-queue.js';
import type { CommunityPrObservations } from '../domains/community/installed-pr-observations.js';
import { resolveStrictUserId } from '../utils/request-identity.js';
import { buildQueueIssues, buildQueuePrItems } from './community-decision-queue-read-model.js';
import { communityObjectReadView, listCommunityIssuesForRepo } from './community-read-identity.js';

export interface CommunityDecisionFindingWaiver {
  reason: string;
  actor: string;
  evidence: string;
}

export interface CommunityDecisionFindingRecord {
  findingId: string;
  subjectKey: string;
  findingKind: string;
  severity: string;
  message: string;
  status: string;
  waiver: CommunityDecisionFindingWaiver | null;
  evidenceFingerprint: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface CommunityDecisionQueueFindingStore {
  get(findingId: string): Promise<CommunityDecisionFindingRecord | null>;
  acknowledge(findingId: string): Promise<void>;
  resolve(findingId: string): Promise<void>;
  waive(findingId: string, waiver: CommunityDecisionFindingWaiver): Promise<void>;
  listAll(): Promise<CommunityDecisionFindingRecord[]>;
}

export interface CommunityDecisionQueueRoutesOptions {
  communityIssueStore: ICommunityIssueStore;
  taskStore: ITaskStore;
  pullRequests?: CommunityPrObservations;
  objectStore?: ICommunityObjectStore;
  findingStore?: CommunityDecisionQueueFindingStore;
}

const findingWaiveSchema = z.object({
  reason: z.string().min(1),
  actor: z.string().min(1).optional(),
  evidence: z.string().min(1),
});

export const communityDecisionQueueRoutes: FastifyPluginAsync<CommunityDecisionQueueRoutesOptions> = async (
  app,
  opts,
) => {
  app.get('/api/community-decision-queue', async (request, reply) => {
    const { repo: requestedRepo } = request.query as { repo?: string };
    const repo = requestedRepo?.trim().toLowerCase();
    if (!repo) {
      reply.status(400);
      return { error: 'Missing repo query parameter' };
    }

    const warnings: string[] = [];
    const issues = await listCommunityIssuesForRepo(opts.communityIssueStore, repo);
    const objectStore = opts.objectStore ? communityObjectReadView(opts.objectStore) : undefined;
    const queueIssues = await buildQueueIssues(repo, issues, objectStore, warnings);
    let prSnapshot: Awaited<ReturnType<CommunityPrObservations['read']>> | undefined;
    try {
      prSnapshot = opts.pullRequests ? await opts.pullRequests.read(repo) : undefined;
    } catch {
      reply.status(503);
      return { error: 'Installed PR observations are unavailable' };
    }
    const prItems = await buildQueuePrItems(repo, opts.taskStore, prSnapshot?.items ?? [], objectStore, warnings);

    const findings = opts.findingStore
      ? await opts.findingStore.listAll()
      : withWarning(warnings, 'findingStore not configured — queue excludes findings', []);

    const items = buildCommunityDecisionQueue({
      repo,
      issues: queueIssues,
      prItems,
      findings,
      now: Date.now(),
    });

    return { repo, items, warnings, prIndex: prSnapshot?.status };
  });

  app.post('/api/community-findings/:findingId/acknowledge', async (request, reply) => {
    const actor = resolveFindingMutationActor(request);
    if (!actor) {
      reply.status(401);
      return { error: 'Authentication required' };
    }
    if (!opts.findingStore) {
      reply.status(501);
      return { error: 'Finding store not configured' };
    }
    const { findingId } = request.params as { findingId: string };
    const finding = await opts.findingStore.get(findingId);
    if (!finding) {
      reply.status(404);
      return { error: 'Finding not found' };
    }
    if (finding.status === 'resolved' || finding.status === 'waived') {
      reply.status(409);
      return { error: `Cannot acknowledge a ${finding.status} finding` };
    }
    if (finding.status === 'open') await opts.findingStore.acknowledge(findingId);
    return { finding: await opts.findingStore.get(findingId) };
  });

  app.post('/api/community-findings/:findingId/resolve', async (request, reply) => {
    const actor = resolveFindingMutationActor(request);
    if (!actor) {
      reply.status(401);
      return { error: 'Authentication required' };
    }
    if (!opts.findingStore) {
      reply.status(501);
      return { error: 'Finding store not configured' };
    }
    const { findingId } = request.params as { findingId: string };
    const finding = await opts.findingStore.get(findingId);
    if (!finding) {
      reply.status(404);
      return { error: 'Finding not found' };
    }
    if (finding.status === 'waived') {
      reply.status(409);
      return { error: 'Cannot resolve a waived finding' };
    }
    if (finding.status === 'open' || finding.status === 'acknowledged') await opts.findingStore.resolve(findingId);
    return { finding: await opts.findingStore.get(findingId) };
  });

  app.post('/api/community-findings/:findingId/waive', async (request, reply) => {
    const actor = resolveFindingMutationActor(request);
    if (!actor) {
      reply.status(401);
      return { error: 'Authentication required' };
    }
    if (!opts.findingStore) {
      reply.status(501);
      return { error: 'Finding store not configured' };
    }
    const { findingId } = request.params as { findingId: string };
    const finding = await opts.findingStore.get(findingId);
    if (!finding) {
      reply.status(404);
      return { error: 'Finding not found' };
    }
    if (finding.status === 'resolved') {
      reply.status(409);
      return { error: 'Cannot waive a resolved finding' };
    }
    const parsed = findingWaiveSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid payload — reason and evidence are required', details: parsed.error.issues };
    }
    const waiver = { ...parsed.data, actor };
    if (finding.status === 'waived') {
      if (sameFindingWaiver(finding.waiver, waiver)) return { finding };
      reply.status(409);
      return { error: 'Cannot waive a waived finding with different audit evidence' };
    }
    await opts.findingStore.waive(findingId, waiver);
    return { finding: await opts.findingStore.get(findingId) };
  });

  app.get('/api/community-findings', async (request, reply) => {
    if (!opts.findingStore) {
      reply.status(501);
      return { error: 'Finding store not configured' };
    }
    const all = await opts.findingStore.listAll();
    const statusParam = (request.query as Record<string, string | undefined>).status;
    if (statusParam) {
      const allowed = new Set(statusParam.split(',').map((status) => status.trim()));
      return { findings: all.filter((finding) => allowed.has(finding.status)) };
    }
    return { findings: all };
  });
};

function resolveFindingMutationActor(request: FastifyRequest): string | null {
  const callbackAuth = (request as FastifyRequest & { callbackAuth?: { catId?: string } }).callbackAuth;
  const callbackCatId = typeof callbackAuth?.catId === 'string' ? callbackAuth.catId.trim() : '';
  if (callbackCatId) return callbackCatId;
  return resolveStrictUserId(request);
}

function sameFindingWaiver(
  existing: CommunityDecisionFindingWaiver | null | undefined,
  next: CommunityDecisionFindingWaiver,
): boolean {
  return existing?.reason === next.reason && existing.actor === next.actor && existing.evidence === next.evidence;
}

function withWarning<T>(warnings: string[], warning: string, value: T): T {
  warnings.push(warning);
  return value;
}
