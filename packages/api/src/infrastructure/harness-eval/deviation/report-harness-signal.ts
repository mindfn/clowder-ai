/**
 * F257 Objective/Eval redesign — MCP signal marker.
 *
 * The tool does not create a deviation result. It marks the authenticated
 * current invocation; after the invocation closes, the marker resolves against
 * its exact TraceEpisode into the same TraceAnnotation shape used by structured
 * rules and semantic sweep.
 */

import { createHash } from 'node:crypto';
import type { PendingTraceMarker } from '@cat-cafe/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { InjectionTraceStore } from '../../../domains/prompt-hooks/InjectionTraceStore.js';
import { getTraceEvaluationStores } from '../../../domains/prompt-hooks/trace-bootstrap.js';
import { requireCallbackPrincipal } from '../../../routes/callback-auth-prehandler.js';
import type { PendingTraceMarkerStore } from '../trace-annotation/PendingTraceMarkerStore.js';
import { resolvePendingTraceMarkers } from '../trace-annotation/resolve-pending-markers.js';
import type { TraceAnnotationStore } from '../trace-annotation/TraceAnnotationStore.js';

const unitRefShape = z
  .object({
    unitType: z.literal('segment'),
    unitId: z.string().min(1),
    clauseId: z.string().min(1).optional(),
  })
  .strict();

export const reportHarnessSignalBodySchema = z
  .object({
    objectiveId: z.string().min(1),
    metricId: z.string().min(1),
    unitRefs: z.array(unitRefShape).min(1),
    polarity: z.enum(['counterexample', 'positive', 'candidate']).default('counterexample'),
    note: z.string().min(1).optional(),
    idempotencyKey: z.string().min(1).optional(),
  })
  .strict();

export interface TraceEvaluationStores {
  traceStore: InjectionTraceStore;
  markerStore: PendingTraceMarkerStore;
  annotationStore: TraceAnnotationStore;
}

export interface ReportInvocationPrincipal {
  invocationId: string;
  threadId: string;
  userId: string;
  catId: string;
}

export interface HandlerReply {
  status: number;
  body: Record<string, unknown>;
}

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export async function handleReportHarnessSignal(
  stores: TraceEvaluationStores,
  principal: ReportInvocationPrincipal,
  rawBody: unknown,
): Promise<HandlerReply> {
  const parsed = reportHarnessSignalBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    const message = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    return { status: 400, body: { error: 'invalid_body', message } };
  }
  const body = parsed.data;
  const markerId = `marker-${digest([
    principal.userId,
    principal.invocationId,
    body.objectiveId,
    body.metricId,
    body.unitRefs,
    body.polarity,
    body.idempotencyKey ?? null,
  ])}`;
  const marker: PendingTraceMarker = {
    markerId,
    invocationId: principal.invocationId,
    ownerUserId: principal.userId,
    subjectCatId: principal.catId,
    objectiveId: body.objectiveId,
    metricId: body.metricId,
    unitRefs: body.unitRefs,
    polarity: body.polarity,
    ...(body.note ? { note: body.note } : {}),
    createdAt: Date.now(),
  };

  const append = await stores.markerStore.append(marker);
  const resolution = await resolvePendingTraceMarkers({ invocationId: principal.invocationId, ...stores });
  return {
    status: 200,
    body: {
      outcome: append.outcome,
      markerId,
      traceStatus: resolution.waitingForTerminal ? 'pending-terminal' : 'resolved',
      annotationsResolved: resolution.resolved,
    },
  };
}

export interface ReportHarnessSignalRouteOptions {
  getStores?: () => TraceEvaluationStores | null;
}

export function registerReportHarnessSignalRoute(
  app: FastifyInstance,
  opts: ReportHarnessSignalRouteOptions = {},
): void {
  app.post('/api/callbacks/harness-signals/report', async (request, reply) => {
    const principal = requireCallbackPrincipal(request, reply);
    if (!principal) return;
    if (principal.kind !== 'invocation') {
      reply.status(409);
      return { error: 'current_invocation_required', message: 'Harness signal markers require invocation auth' };
    }
    const stores = (opts.getStores ?? getTraceEvaluationStores)();
    if (!stores) {
      reply.status(503);
      return { error: 'trace_evaluation_store_unavailable', message: 'Trace marker storage requires Redis' };
    }
    const res = await handleReportHarnessSignal(
      stores,
      {
        invocationId: principal.invocationId,
        threadId: principal.threadId,
        userId: principal.userId,
        catId: principal.catId,
      },
      request.body,
    );
    reply.status(res.status);
    return res.body;
  });
}
