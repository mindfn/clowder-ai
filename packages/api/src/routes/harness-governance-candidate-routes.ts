/** F257 operator decision boundary: Candidate approval executes override + opens PatchTrial. */

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
    error.message === 'governance_candidate_owner_mismatch' ||
    error.message === 'governance_candidate_baseline_unavailable' ||
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
  if (candidate.targetSegmentIds.length !== 1 || candidate.proposedAction.mechanism !== 'override-disable') {
    return reply.status(409).send({ error: 'Candidate is not executable by the override-disable executor' });
  }
  const segmentId = candidate.targetSegmentIds[0];
  const hookId = opts.resolveHookId(segmentId);
  if (!hookId) return reply.status(409).send({ error: `No prompt hook owns segment '${segmentId}'` });
  const note = noteFromBody(body, `Approved governance Candidate ${candidateId}`);
  const approvedAt = opts.now?.() ?? Date.now();

  // Idempotent retry after the durable Candidate transition never executes
  // another override mutation or opens another PatchTrial.
  if (candidate.status !== 'proposed' && candidate.status !== 'executing') {
    const governance = await opts.candidateStore.approveAndOpenPatchTrial({
      candidateId,
      approvedBy: userId,
      note,
      hookId,
      approvedAt,
    });
    return reply.send({ ok: true, candidateId, hookId, governance, deduped: true });
  }

  // Persist `executing` before the external override side effect. A crash or
  // refresh failure can then be resumed safely; rejection can never win after
  // the override may already have been applied.
  await opts.candidateStore.beginApproval(candidateId, userId);
  await opts.overrideStore.disable(hookId, userId, { source: 'operator', reason: note });
  await opts.refreshOverrideSnapshot?.();
  const governance = await opts.candidateStore.approveAndOpenPatchTrial({
    candidateId,
    approvedBy: userId,
    note,
    hookId,
    approvedAt,
  });
  notifyDecision(opts, userId, candidateId, 'approved');
  return reply.send({ ok: true, candidateId, hookId, governance, deduped: false });
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
