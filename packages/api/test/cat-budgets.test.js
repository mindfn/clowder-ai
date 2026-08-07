import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

const { clearBudgetCache, getAllCatCapacities, getCatCapacity } = await import('../dist/config/cat-budgets.js');

describe('cat capacity projections (#1208)', () => {
  before(() => clearBudgetCache());

  it('exposes capacity provenance without prompt-policy knobs', () => {
    const capacity = getCatCapacity('opus');
    assert.equal(typeof capacity.windowTokens, 'number');
    assert.equal(typeof capacity.inputCeilingTokens, 'number');
    assert.equal(typeof capacity.source, 'string');
    assert.equal(typeof capacity.actionable, 'boolean');
    assert.equal('budget' in capacity, false);
    assert.equal('maxPromptTokens' in capacity, false);
    assert.equal('maxMessages' in capacity, false);
  });

  it('projects every registered member', () => {
    const capacities = getAllCatCapacities();
    assert.ok(Object.keys(capacities).length > 0);
    for (const capacity of Object.values(capacities)) {
      assert.ok(capacity.bindingKey);
      assert.equal(typeof capacity.fingerprint, 'string');
      assert.ok(capacity.observedAt > 0);
    }
  });
});
