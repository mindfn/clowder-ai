import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { z } from 'zod';
import {
  readCycleStatusInputSchema,
  submitCycleGovernanceInputSchema,
  unitEvaluationTools,
} from '../src/tools/unit-evaluation-tools.js';

describe('F257 cycle evaluation MCP surface', () => {
  test('exposes only the cycle contract and its read-only unit schema', () => {
    const names = unitEvaluationTools.map((tool) => tool.name);
    assert.deepEqual(names, [
      'cat_cafe_read_cycle_status',
      'cat_cafe_read_cycle_traces',
      'cat_cafe_submit_cycle_evaluation',
      'cat_cafe_describe_harness_unit',
      'cat_cafe_submit_cycle_governance',
    ]);
    assert.equal(names.includes('cat_cafe_retrieve_unit_evaluation_traces'), false);
    assert.equal(names.includes('cat_cafe_submit_unit_evaluation'), false);

    const statusTool = unitEvaluationTools[0];
    assert.match(statusTool.description, /idle/i);
    assert.match(statusTool.description, /event-driven/i);
    assert.match(statusTool.description, /do not call hold_ball/i);
    assert.match(statusTool.description, /Use when:/);
    assert.match(statusTool.description, /NOT for:/);
    assert.match(statusTool.description, /Output:/);
    assert.match(statusTool.description, /GOTCHA:/);
    assert.equal(z.object(readCycleStatusInputSchema).strict().safeParse({ objectiveId: 'obj' }).success, true);
    assert.equal(
      z.object(readCycleStatusInputSchema).strict().safeParse({ objectiveId: 'obj', cycleId: 'invented' }).success,
      false,
    );
  });

  test('accepts a writer-compatible numeric hook id and markdown template in an evolve draft', () => {
    const result = z
      .object(submitCycleGovernanceInputSchema)
      .strict()
      .safeParse({
        objectiveId: 'turn-custody-closure',
        cycleId: 'cycle-1',
        decision: 'evolve',
        reason: 'Add the missing terminal checkpoint.',
        v2Draft: {
          changes: [
            {
              action: 'add',
              reason: 'Close unresolved custodial turns.',
              unit: {
                unitId: 'D22',
                assetSlug: 'd22-custody-closure-checkpoint',
                manifest: {
                  id: 'D22',
                  name: 'Custody closure checkpoint',
                  stage: 'per-turn',
                  order: 22,
                  version: 1,
                  enabled: true,
                  template: 'd22-custody-closure-checkpoint.md',
                  inputs: [],
                  disableable: true,
                  safetyTier: 'readonly',
                  transparencyTier: 'visible-by-default',
                  governanceTier: 'human-gated',
                },
                content: 'Require one observable custody exit before ending the turn.',
                objectives: [{ objectiveId: 'turn-custody-closure' }],
              },
            },
          ],
        },
      });

    assert.equal(result.success, true, result.success ? undefined : JSON.stringify(result.error.issues));
  });
});
