import { z } from 'zod';
import { defineMcpMigrationFactory } from '../tool-governance-migration.js';
import { callbackPost } from './callback-tools.js';
import type { ToolResult } from './file-tools.js';

const defineTool = defineMcpMigrationFactory('unit-evaluation-tools.ts', undefined, {
  resourceFamily: 'harness-evaluation',
  authority: 'eval-callback',
});

const identifier = z.string().trim().min(1).max(200);
const evidenceRefs = z.array(identifier).max(64);
const howCounted = z.string().trim().min(1).max(2_000);
const conclusionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('count'), value: z.number().int().nonnegative(), howCounted }),
  z.object({ kind: z.literal('rate-badness'), value: z.number().min(0).max(1), howCounted }),
  z.object({
    kind: z.literal('semantic-label'),
    label: z.string().trim().min(1).max(200),
    count: z.number().int().nonnegative(),
    howCounted,
  }),
]);

export const readCycleTracesInputSchema = {
  objectiveId: identifier.describe('Objective id from the cycle assignment.'),
  cycleId: identifier.describe('Exact CycleRecord id from the assignment.'),
  cursor: z.number().int().nonnegative().default(0).describe('Cursor returned by the prior page; start at 0.'),
  limit: z.number().int().min(1).max(25).default(10).describe('Bounded trace page size (1-25).'),
};

export const submitCycleEvaluationInputSchema = {
  objectiveId: identifier.describe('Objective id from the cycle assignment.'),
  cycleId: identifier.describe('Exact CycleRecord id from the assignment.'),
  metrics: z
    .array(z.object({ id: identifier, conclusion: conclusionSchema, evidenceRefs }))
    .min(1)
    .describe('Exactly one conclusion for every metric in the assignment; references name inspected invocations.'),
  overall: z
    .enum(['complete', 'partial', 'insufficient_evidence'])
    .describe('Whether the evidence supports a complete, partial, or skipped evaluation.'),
};

export const describeHarnessUnitInputSchema = {
  unitId: identifier.describe('Harness unit id attached to the Objective, such as S6 or D5.'),
};

interface ReadCycleTracesInput extends Record<string, unknown> {
  objectiveId: string;
  cycleId: string;
  cursor: number;
  limit: number;
}

interface SubmitCycleEvaluationInput extends Record<string, unknown> {
  objectiveId: string;
  cycleId: string;
  metrics: Array<{ id: string; conclusion: z.infer<typeof conclusionSchema>; evidenceRefs: string[] }>;
  overall: 'complete' | 'partial' | 'insufficient_evidence';
}

interface DescribeHarnessUnitInput extends Record<string, unknown> {
  unitId: string;
}

export async function handleReadCycleTracesTool(input: ReadCycleTracesInput): Promise<ToolResult> {
  return callbackPost('/api/callbacks/harness-signals/read-cycle-traces', input, { retryDelaysMs: [] });
}

export async function handleSubmitCycleEvaluationTool(input: SubmitCycleEvaluationInput): Promise<ToolResult> {
  return callbackPost('/api/callbacks/harness-signals/submit-cycle-evaluation', input, { retryDelaysMs: [] });
}

export async function handleDescribeHarnessUnitTool(input: DescribeHarnessUnitInput): Promise<ToolResult> {
  return callbackPost('/api/callbacks/harness-signals/describe-harness-unit', input, { retryDelaysMs: [] });
}

export const unitEvaluationTools = [
  defineTool({
    name: 'cat_cafe_read_cycle_traces',
    description:
      'Read a bounded page of immutable owner traces for the exact F257 Objective cycle assigned to the current invocation. Counterexamples are returned first; cursor continuity is stateless and no trace bodies are copied into the assignment.',
    inputSchema: readCycleTracesInputSchema,
    handler: handleReadCycleTracesTool,
    governance: {
      implementationExport: 'handleReadCycleTracesTool',
      action: 'read-cycle-traces',
      risk: { level: 'read', openWorld: false },
      runtimeProfiles: ['full'],
    },
  }),
  defineTool({
    name: 'cat_cafe_submit_cycle_evaluation',
    description:
      'Write the structured per-metric conclusions for the exact F257 Objective cycle assigned to this invocation. The API validates metric coverage, conclusion kinds, evidence ownership, Objective membership, and cycle windows.',
    inputSchema: submitCycleEvaluationInputSchema,
    handler: handleSubmitCycleEvaluationTool,
    governance: {
      implementationExport: 'handleSubmitCycleEvaluationTool',
      action: 'submit-cycle-evaluation',
      risk: { level: 'write', openWorld: false },
      runtimeProfiles: ['full'],
    },
  }),
  defineTool({
    name: 'cat_cafe_describe_harness_unit',
    description:
      'Describe one harness unit before drafting governance: allowed enable/disable/modify/add actions, effective state, active version, immutable version chain, and content pointers. This is read-only.',
    inputSchema: describeHarnessUnitInputSchema,
    handler: handleDescribeHarnessUnitTool,
    governance: {
      implementationExport: 'handleDescribeHarnessUnitTool',
      action: 'describe-harness-unit',
      risk: { level: 'read', openWorld: false },
      runtimeProfiles: ['full'],
    },
  }),
] as const;
