/**
 * F167 — the stop-gate remedial prompt must name the way out that exists for the wake that is actually owed.
 *
 * An event-wait wake used to get the generic prompt, which lists "完成候选、结构化传球、returnToPredecessor、hold_ball、
 * 已注册的 eventWait": none of them is "this wake's work is done", so a holder who had finished was told to invent a
 * continuation. Each protocol now names its own completion tool and no one else's.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildTurnCustodyStopGateRemedialPrompt } from '../dist/domains/cats/services/agents/routing/route-serial.js';
import { realWaitWake } from './helpers/event-wait-terminal-fixture.js';

const ids = { holderCatId: 'codex-astra', subjectKey: 'ball:thread:thread-x' };
const COMPLETERS = ['cat_cafe_complete_event_wait', 'cat_cafe_complete_managed_hold', 'cat_cafe_complete_a2a_dispatch'];

const named = (prompt) => COMPLETERS.filter((tool) => prompt.includes(tool));

describe('F167 stop-gate remedial prompt per protocol', () => {
  test('a matched event-wait wake is told to complete it with the event-wait terminal, and only that one', () => {
    const prompt = buildTurnCustodyStopGateRemedialPrompt(realWaitWake('matched', ids));

    assert.deepEqual(named(prompt), ['cat_cafe_complete_event_wait']);
    assert.match(prompt, /handled/);
    assert.match(prompt, /completed/);
    assert.match(prompt, /hold_ball/, 'unfinished work still has its continuation moves');
  });

  test('the other protocols keep naming exactly their own completion tool', () => {
    const hold = buildTurnCustodyStopGateRemedialPrompt({
      kind: 'structured',
      protocol: 'hold',
      subjectKey: ids.subjectKey,
      holderCatId: ids.holderCatId,
      sourceMessageId: 'm1',
      taskId: 't1',
    });
    assert.deepEqual(named(hold), ['cat_cafe_complete_managed_hold']);

    const dispatch = buildTurnCustodyStopGateRemedialPrompt({
      kind: 'structured',
      protocol: 'dispatch',
      subjectKey: ids.subjectKey,
      holderCatId: ids.holderCatId,
      handoff: { sourceEventId: 'route:m1:codex-astra', messageId: 'm1', fromCatId: 'sonnet' },
    });
    assert.deepEqual(named(dispatch), ['cat_cafe_complete_a2a_dispatch']);
  });

  test('a wake with no completion producer does not invent one', () => {
    const generic = buildTurnCustodyStopGateRemedialPrompt({ kind: 'legacy', reason: 'carrier_missing' });
    assert.deepEqual(named(generic), []);
  });
});
