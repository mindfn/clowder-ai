/** Structured wake labels do not invent a second completion owner in the Stop prompt. */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildTurnCustodyStopGateRemedialPrompt } from '../dist/domains/cats/services/agents/routing/route-serial.js';
import { realWaitWake } from './helpers/event-wait-terminal-fixture.js';

const ids = { holderCatId: 'codex-astra', subjectKey: 'ball:thread:thread-x' };
const COMPLETERS = [
  'cat_cafe_complete_event_wait', // mcp-cutover-negative-reference: absence
  'cat_cafe_complete_managed_hold', // mcp-cutover-negative-reference: absence
  'cat_cafe_complete_a2a_dispatch', // mcp-cutover-negative-reference: absence
];

const named = (prompt) => COMPLETERS.filter((tool) => prompt.includes(tool));

describe('F167 Stop prompt preserves existing actions without protocol-specific inference', () => {
  test('a matched event-wait wake does not infer a completion tool from its label', () => {
    const prompt = buildTurnCustodyStopGateRemedialPrompt(realWaitWake('matched', ids));

    assert.deepEqual(named(prompt), []);
    assert.match(prompt, /returnToPredecessor/);
    assert.match(prompt, /eventWait/);
    assert.match(prompt, /hold_ball/, 'unfinished work still has its continuation moves');
  });

  test('hold and dispatch labels do not create completion authority', () => {
    const hold = buildTurnCustodyStopGateRemedialPrompt({
      kind: 'structured',
      protocol: 'hold',
      subjectKey: ids.subjectKey,
      holderCatId: ids.holderCatId,
      sourceMessageId: 'm1',
      taskId: 't1',
    });
    assert.deepEqual(named(hold), []);
    assert.match(hold, /hold_ball/);

    const dispatch = buildTurnCustodyStopGateRemedialPrompt({
      kind: 'structured',
      protocol: 'dispatch',
      subjectKey: ids.subjectKey,
      holderCatId: ids.holderCatId,
      handoff: { sourceEventId: 'route:m1:codex-astra', messageId: 'm1', fromCatId: 'sonnet' },
    });
    assert.deepEqual(named(dispatch), []);
    assert.match(dispatch, /结构化传球/);
  });

  test('a wake with no completion producer does not invent one', () => {
    const generic = buildTurnCustodyStopGateRemedialPrompt({ kind: 'legacy', reason: 'carrier_missing' });
    assert.deepEqual(named(generic), []);
  });
});
