import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { unitEvaluationTools } from '../src/tools/unit-evaluation-tools.js';

describe('F257 cycle evaluation MCP surface', () => {
  test('exposes only the cycle contract and its read-only unit schema', () => {
    const names = unitEvaluationTools.map((tool) => tool.name);
    assert.deepEqual(names, [
      'cat_cafe_read_cycle_traces',
      'cat_cafe_submit_cycle_evaluation',
      'cat_cafe_describe_harness_unit',
      'cat_cafe_submit_cycle_governance',
    ]);
    assert.equal(names.includes('cat_cafe_retrieve_unit_evaluation_traces'), false);
    assert.equal(names.includes('cat_cafe_submit_unit_evaluation'), false);
  });
});
