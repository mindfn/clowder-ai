import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ObjectiveEvaluationRuntime } from '../infrastructure/harness-eval/evaluation/ObjectiveEvaluationRuntime.js';
import { SegmentEvaluationReadModel } from '../infrastructure/harness-eval/evaluation/SegmentEvaluationReadModel.js';

export interface SegmentEvaluationRoutesOptions {
  runtime?: ObjectiveEvaluationRuntime;
}

const DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

function requireSession(request: FastifyRequest, reply: FastifyReply): string | null {
  const userId = (request as FastifyRequest & { sessionUserId?: string }).sessionUserId;
  if (userId) return userId;
  reply.status(401).send({ error: 'Session required' });
  return null;
}

function parseWindowMs(raw: string | undefined): number | null {
  if (raw === undefined) return DEFAULT_WINDOW_MS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.min(value, MAX_WINDOW_MS);
}

export const segmentEvaluationRoutes: FastifyPluginAsync<SegmentEvaluationRoutesOptions> = async (app, opts) => {
  app.get('/api/segment-evaluation/:segmentId', async (request, reply) => {
    const ownerUserId = requireSession(request, reply);
    if (!ownerUserId) return;
    if (!opts.runtime) return reply.status(503).send({ error: 'Objective evaluation runtime unavailable' });

    const { segmentId } = request.params as { segmentId: string };
    const windowMs = parseWindowMs((request.query as { windowMs?: string }).windowMs);
    if (windowMs === null) return reply.status(400).send({ error: 'windowMs must be a finite positive number' });
    const endMs = Date.now();
    try {
      return reply.send(
        await new SegmentEvaluationReadModel(opts.runtime).read({
          ownerUserId,
          segmentId,
          startMs: endMs - windowMs,
          endMs,
        }),
      );
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('segment_evaluation_unit_not_found:')) {
        return reply.status(404).send({ error: 'Segment evaluation manifest entry not found' });
      }
      throw error;
    }
  });
};
