import assert from 'node:assert/strict';
import test from 'node:test';

import { parseAcceptanceCriteria } from './lib/feature-acceptance-criteria.mjs';

test('parses the acceptance-criterion label forms used by feature specs', () => {
  const markdown = [
    '- [x] AC-1: baseline criterion',
    '- [ ] AC-P2-1: phase criterion with a hyphenated suffix',
    '- [ ] **AC-PCFU-4**: emphasized criterion',
    '- [x] AC-C2 / AC-C3: combined criterion',
  ].join('\n');

  assert.deepEqual(parseAcceptanceCriteria(markdown), [
    { checked: true, label: 'AC-1' },
    { checked: false, label: 'AC-P2-1' },
    { checked: false, label: 'AC-PCFU-4' },
    { checked: true, label: 'AC-C2 / AC-C3' },
  ]);
});

test('ignores ordinary task checkboxes that are not acceptance criteria', () => {
  assert.deepEqual(parseAcceptanceCriteria('- [ ] runtime validation pending'), []);
});
