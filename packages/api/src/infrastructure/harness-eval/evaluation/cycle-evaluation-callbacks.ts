import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireCallbackPrincipal } from '../../../routes/callback-auth-prehandler.js';
import type { CycleEvaluationCoordinator, CycleEvaluationPrincipal } from './CycleEvaluationCoordinator.js';
import type { HarnessUnitDescriber } from './HarnessUnitDescriber.js';

const identifier = z.string().trim().min(1).max(200);
const evidenceRefs = z.array(identifier).max(64);
const howCounted = z.string().trim().min(1).max(2_000);
const conclusion = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('count'), value: z.number().int().nonnegative(), howCounted }).strict(),
  z.object({ kind: z.literal('rate-badness'), value: z.number().min(0).max(1), howCounted }).strict(),
  z
    .object({
      kind: z.literal('semantic-label'),
      label: z.string().trim().min(1).max(200),
      count: z.number().int().nonnegative(),
      howCounted,
    })
    .strict(),
]);

export const readCycleTracesBodySchema = z
  .object({
    objectiveId: identifier,
    cycleId: identifier,
    cursor: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(25).default(10),
  })
  .strict();

export const submitCycleEvaluationBodySchema = z
  .object({
    objectiveId: identifier,
    cycleId: identifier,
    metrics: z.array(z.object({ id: identifier, conclusion, evidenceRefs }).strict()).min(1),
    overall: z.enum(['complete', 'partial', 'insufficient_evidence']),
  })
  .strict();

export const describeHarnessUnitBodySchema = z.object({ unitId: identifier }).strict();

type HandlerResult = { status: number; body: unknown };

export async function handleReadCycleTraces(
  coordinator: CycleEvaluationCoordinator,
  principal: CycleEvaluationPrincipal,
  rawBody: unknown,
): Promise<HandlerResult> {
  const parsed = readCycleTracesBodySchema.safeParse(rawBody);
  if (!parsed.success) return invalidBody(parsed.error.issues);
  try {
    return { status: 200, body: await coordinator.readTraces(principal, parsed.data) };
  } catch (error) {
    return cycleError(error);
  }
}

export async function handleSubmitCycleEvaluation(
  coordinator: CycleEvaluationCoordinator,
  principal: CycleEvaluationPrincipal,
  rawBody: unknown,
): Promise<HandlerResult> {
  const parsed = submitCycleEvaluationBodySchema.safeParse(rawBody);
  if (!parsed.success) return invalidBody(parsed.error.issues);
  try {
    return { status: 200, body: await coordinator.submitEvaluation(principal, parsed.data) };
  } catch (error) {
    return cycleError(error);
  }
}

export async function handleDescribeHarnessUnit(
  describer: HarnessUnitDescriber,
  rawBody: unknown,
): Promise<HandlerResult> {
  const parsed = describeHarnessUnitBodySchema.safeParse(rawBody);
  if (!parsed.success) return invalidBody(parsed.error.issues);
  try {
    return { status: 200, body: await describer.describe(parsed.data.unitId) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith('harness_unit_not_found:'))
      return { status: 404, body: { error: 'harness_unit_not_found' } };
    if (message.startsWith('harness_hook_not_available:')) {
      return { status: 503, body: { error: 'harness_hook_not_available' } };
    }
    throw error;
  }
}

export function registerCycleEvaluationCallbackRoutes(
  app: FastifyInstance,
  coordinator: CycleEvaluationCoordinator,
  describer: HarnessUnitDescriber,
): void {
  app.post('/api/callbacks/harness-signals/read-cycle-traces', async (request, reply) => {
    const principal = invocationPrincipal(request, reply);
    if (!principal) return;
    const result = await handleReadCycleTraces(coordinator, principal, request.body);
    reply.status(result.status);
    return result.body;
  });
  app.post('/api/callbacks/harness-signals/submit-cycle-evaluation', async (request, reply) => {
    const principal = invocationPrincipal(request, reply);
    if (!principal) return;
    const result = await handleSubmitCycleEvaluation(coordinator, principal, request.body);
    reply.status(result.status);
    return result.body;
  });
  app.post('/api/callbacks/harness-signals/describe-harness-unit', async (request, reply) => {
    if (!requireCallbackPrincipal(request, reply)) return;
    const result = await handleDescribeHarnessUnit(describer, request.body);
    reply.status(result.status);
    return result.body;
  });
}

function invocationPrincipal(
  request: Parameters<typeof requireCallbackPrincipal>[0],
  reply: Parameters<typeof requireCallbackPrincipal>[1],
): CycleEvaluationPrincipal | null {
  const principal = requireCallbackPrincipal(request, reply);
  if (!principal) return null;
  if (principal.kind !== 'invocation') {
    reply.status(409).send({ error: 'current_invocation_required' });
    return null;
  }
  return { userId: principal.userId, catId: principal.catId, threadId: principal.threadId };
}

function invalidBody(issues: z.ZodIssue[]): HandlerResult {
  return { status: 400, body: { error: 'invalid_body', issues } };
}

function cycleError(error: unknown): HandlerResult {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith('cycle_evaluation_principal_mismatch:')) {
    return { status: 403, body: { error: 'cycle_evaluation_principal_mismatch' } };
  }
  if (message.startsWith('cycle_evaluation_not_found:')) {
    return { status: 404, body: { error: 'cycle_evaluation_not_found' } };
  }
  if (
    message.startsWith('cycle_evaluation_not_active:') ||
    message.startsWith('cycle_evaluation_conflict:') ||
    message.startsWith('cycle_trace_cursor_out_of_range:')
  ) {
    return { status: 409, body: { error: message.split(':', 1)[0] } };
  }
  if (
    message.startsWith('cycle_evaluation_metric_') ||
    message.startsWith('cycle_evaluation_evidence_limit:') ||
    message.startsWith('cycle_evaluation_invalid_evidence_ref:') ||
    message.startsWith('cycle_evaluation_rate_out_of_range') ||
    message.startsWith('cycle_evaluation_value_invalid') ||
    message.startsWith('cycle_record_too_large:')
  ) {
    return { status: 400, body: { error: 'invalid_cycle_evaluation', message } };
  }
  throw error;
}
