import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('F150 guide registry loader target validation', async () => {
  const { isValidGuideTarget, loadGuideFlow } = await import('../dist/domains/guides/guide-registry-loader.js');

  test('accepts registry-safe target ids', () => {
    assert.equal(isValidGuideTarget('hub.trigger'), true);
    assert.equal(isValidGuideTarget('cats.add-member'), true);
    assert.equal(isValidGuideTarget('members.row_new-confirm'), true);
  });

  test('rejects selector-breaking target ids', () => {
    assert.equal(isValidGuideTarget('bad"]div'), false);
    assert.equal(isValidGuideTarget('bad target'), false);
    assert.equal(isValidGuideTarget('bad>target'), false);
  });

  test('loaded add-member flow contains only validated targets', () => {
    const flow = loadGuideFlow('add-member');
    for (const step of flow.steps) {
      assert.equal(isValidGuideTarget(step.target), true, `step ${step.id} target should be valid`);
    }
  });

  test('loaded add-member flow waits for member profile save before completion', () => {
    const flow = loadGuideFlow('add-member');
    const createIndex = flow.steps.findIndex((step) => step.id === 'click-add-member');
    const editIndex = flow.steps.findIndex((step) => step.id === 'edit-member-profile');
    const editStep = flow.steps[editIndex];

    assert.ok(createIndex >= 0, 'create step should exist');
    assert.ok(editIndex > createIndex, 'edit step should happen after member creation');
    assert.ok(editStep, 'edit-member-profile step should exist');
    assert.equal(editStep.target, 'member-editor.profile');
    assert.equal(editStep.advance, 'confirm');
  });
});
