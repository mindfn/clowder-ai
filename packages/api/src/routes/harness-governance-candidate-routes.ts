/** F257 operator boundary: approve applies one content-version decision and closes the Candidate. */

import type { Candidate } from '@cat-cafe/shared';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import {
  requireConnectorWriteNetworkGuard,
  requireConnectorWriteOwner,
} from '../config/connector-secret-write-guards.js';
import type { HookOverrideStore } from '../domains/prompt-hooks/HookOverrideStore.js';
import { OverrideGateError } from '../domains/prompt-hooks/HookOverrideStore.js';
import type { CandidateStore } from '../infrastructure/harness-eval/governance/CandidateStore.js';

export interface HarnessGovernanceCandidateRoutesOptions {
  candidateStore?: CandidateStore;
  overrideStore?: HookOverrideStore;
  resolveHookId: (segmentId: string) => string | null;
  refreshOverrideSnapshot?: () => Promise<void>;
  notifyDecision?: (ownerUserId: string, candidateId: string, status: 'approved' | 'rejected') => void;
  now?: () => number;
}

function requireWriteAuth(request: FastifyRequest, reply: FastifyReply): string | null {
  const userId = (request as FastifyRequest & { sessionUserId?: string }).sessionUserId?.trim();
  if (!userId) {
    reply.status(401).send({ error: 'Session required' });
    return null;
  }
  const networkError = requireConnectorWriteNetworkGuard(request);
  if (networkError) {
    reply.status(networkError.status).send({ error: networkError.error });
    return null;
  }
  const ownerError = requireConnectorWriteOwner(userId);
  if (ownerError) {
    reply.status(ownerError.status).send({ error: ownerError.error });
    return null;
  }
  return userId;
}

function noteFromBody(body: unknown, fallback: string): string {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fallback;
  const note = (body as Record<string, unknown>).note;
  return typeof note === 'string' && note.trim() ? note.trim() : fallback;
}

function mapCandidateError(error: unknown, reply: FastifyReply): boolean {
  if (error instanceof OverrideGateError) {
    reply.status(error.gate === 'unknown-hook' ? 404 : 409).send({
      error: error.message,
      gate: error.gate,
      hookId: error.hookId,
    });
    return true;
  }
  if (!(error instanceof Error)) return false;
  if (error.message === 'governance_candidate_not_found') {
    reply.status(404).send({ error: 'Governance Candidate not found for this operator' });
    return true;
  }
  if (
    error.message === 'governance_candidate_not_proposed' ||
    error.message === 'governance_candidate_not_executing' ||
    error.message === 'governance_candidate_owner_mismatch' ||
    error.message === 'governance_candidate_baseline_unavailable' ||
    error.message === 'governance_candidate_source_version_changed' ||
    error.message === 'governance_candidate_concurrent_transition'
  ) {
    reply.status(409).send({ error: error.message });
    return true;
  }
  return false;
}

export const harnessGovernanceCandidateRoutes: FastifyPluginAsync<HarnessGovernanceCandidateRoutesOptions> = async (
  app,
  opts,
) => {
  app.post('/api/harness-governance-candidates/:candidateId/approve', (request, reply) =>
    approveCandidate(request, reply, opts),
  );
  app.post('/api/harness-governance-candidates/:candidateId/reject', (request, reply) =>
    rejectCandidate(request, reply, opts),
  );
};

async function approveCandidate(
  request: FastifyRequest,
  reply: FastifyReply,
  opts: HarnessGovernanceCandidateRoutesOptions,
): Promise<unknown> {
  const userId = requireWriteAuth(request, reply);
  if (!userId) return;
  if (!opts.candidateStore || !opts.overrideStore) {
    return reply.status(503).send({ error: 'Harness governance executor unavailable' });
  }
  const candidateStore = opts.candidateStore;
  const overrideStore = opts.overrideStore;
  const { candidateId } = request.params as { candidateId: string };
  try {
    return await candidateStore.withDecisionLock(candidateId, () =>
      executeApproval(userId, candidateId, request.body, reply, {
        ...opts,
        candidateStore,
        overrideStore,
      }),
    );
  } catch (error) {
    if (!mapCandidateError(error, reply)) throw error;
  }
}

async function executeApproval(
  userId: string,
  candidateId: string,
  body: unknown,
  reply: FastifyReply,
  opts: HarnessGovernanceCandidateRoutesOptions & {
    candidateStore: CandidateStore;
    overrideStore: HookOverrideStore;
  },
): Promise<unknown> {
  const candidate = await opts.candidateStore.get(candidateId);
  const context = await opts.candidateStore.getEvaluationContext(candidateId);
  if (!candidate || !context || context.ownerUserId !== userId) {
    return reply.status(404).send({ error: 'Governance Candidate not found for this operator' });
  }
  const action = executableAction(candidate);
  if (!action) {
    return reply.status(409).send({ error: 'Candidate is not executable by the content-version executor' });
  }
  const segmentId = candidate.targetSegmentIds[0];
  const hookId = opts.resolveHookId(segmentId);
  if (!hookId) return reply.status(409).send({ error: `No prompt hook owns segment '${segmentId}'` });
  const note = noteFromBody(body, `Approved governance Candidate ${candidateId}`);
  const approvedAt = opts.now?.() ?? Date.now();

  if (candidate.status === 'closed' && candidate.approval.approvedBy === userId) {
    return reply.send({ ok: true, candidateId, hookId, candidate, deduped: true });
  }
  if (candidate.status !== 'proposed' && candidate.status !== 'executing') {
    throw new Error('governance_candidate_not_proposed');
  }

  const resuming = candidate.status === 'executing';
  const currentVersion = await opts.overrideStore.getActiveVersion(hookId);
  if (!resuming && currentVersion !== action.sourceVersion) {
    throw new Error('governance_candidate_source_version_changed');
  }
  await opts.candidateStore.beginApproval(candidateId, userId);
  const alreadyApplied = resuming && (await actionIsAlreadyApplied(action, hookId, opts.overrideStore));
  if (!alreadyApplied && currentVersion !== action.sourceVersion) {
    throw new Error('governance_candidate_source_version_changed');
  }
  if (!alreadyApplied) await applyAction(action, hookId, userId, note, opts.overrideStore);
  await opts.refreshOverrideSnapshot?.();
  const closed = await opts.candidateStore.settleApproval({ candidateId, approvedBy: userId, note, approvedAt });
  notifyDecision(opts, userId, candidateId, 'approved');
  return reply.send({ ok: true, candidateId, hookId, candidate: closed, deduped: alreadyApplied });
}

type ExecutableAction =
  | { kind: 'change-content'; proposedContent: string; sourceVersion: number }
  | { kind: 'rollback'; targetVersion: number; sourceVersion: number };

function executableAction(candidate: Candidate): ExecutableAction | null {
  if (candidate.targetSegmentIds.length !== 1 || candidate.proposedAction.mechanism !== 'override-content') {
    return null;
  }
  const content = candidate.proposedAction.contentDraft?.proposedContent;
  const rollback = candidate.proposedAction.rollbackToVersion;
  const sourceVersion = candidate.proposedAction.sourceVersion;
  if (typeof sourceVersion !== 'number' || !Number.isInteger(sourceVersion) || sourceVersion < 1) return null;
  if (typeof content === 'string' && content.trim() && rollback === undefined) {
    return { kind: 'change-content', proposedContent: content, sourceVersion };
  }
  if (content === undefined && typeof rollback === 'number' && Number.isInteger(rollback) && rollback >= 1) {
    return { kind: 'rollback', targetVersion: rollback, sourceVersion };
  }
  return null;
}

async function actionIsAlreadyApplied(
  action: ExecutableAction,
  hookId: string,
  overrideStore: HookOverrideStore,
): Promise<boolean> {
  if (action.kind === 'change-content') {
    return (await overrideStore.getOverride(hookId))?.contentOverride === action.proposedContent;
  }
  return (await overrideStore.getActiveVersion(hookId)) === action.targetVersion;
}

async function applyAction(
  action: ExecutableAction,
  hookId: string,
  ownerUserId: string,
  note: string,
  overrideStore: HookOverrideStore,
): Promise<void> {
  if (action.kind === 'change-content') {
    await overrideStore.setContentOverride(hookId, action.proposedContent, ownerUserId, {
      source: 'operator',
      reason: note,
    });
    return;
  }
  await overrideStore.activateVersion(hookId, action.targetVersion, ownerUserId, {
    source: 'operator',
    reason: note,
  });
}

async function rejectCandidate(
  request: FastifyRequest,
  reply: FastifyReply,
  opts: HarnessGovernanceCandidateRoutesOptions,
): Promise<unknown> {
  const userId = requireWriteAuth(request, reply);
  if (!userId) return;
  if (!opts.candidateStore) return reply.status(503).send({ error: 'Harness governance store unavailable' });
  const candidateStore = opts.candidateStore;
  const { candidateId } = request.params as { candidateId: string };
  try {
    const candidate = await candidateStore.withDecisionLock(candidateId, () =>
      candidateStore.reject({
        candidateId,
        rejectedBy: userId,
        note: noteFromBody(request.body, `Rejected governance Candidate ${candidateId}`),
        rejectedAt: opts.now?.() ?? Date.now(),
      }),
    );
    notifyDecision(opts, userId, candidateId, 'rejected');
    return reply.send({ ok: true, candidateId, candidate });
  } catch (error) {
    if (!mapCandidateError(error, reply)) throw error;
  }
}

function notifyDecision(
  opts: HarnessGovernanceCandidateRoutesOptions,
  userId: string,
  candidateId: string,
  status: 'approved' | 'rejected',
): void {
  try {
    opts.notifyDecision?.(userId, candidateId, status);
  } catch {
    /* websocket fan-out is best-effort after the durable decision */
  }
}
