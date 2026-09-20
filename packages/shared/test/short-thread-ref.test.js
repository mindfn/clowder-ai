import assert from 'node:assert/strict';
import test from 'node:test';
import { shortThreadRef } from '../dist/index.js';

// Regression for docs/bug-report/ghost-thread-cross-thread-session-routing/ (R-3):
// a raw 8-char slice of a real threadId is the constant "thread_m", which destroyed
// cross-post provenance in the prompt path for every thread in the normal id space.
test('shortThreadRef discriminates real-shaped thread ids', () => {
  const ids = [
    'thread_msr51149hym0i79f',
    'thread_mrkmxgdfqquounc9',
    'thread_mu8dg6h7l2x4ohsk',
    'thread_mrkn6povq4zzgh45',
    'thread_mq6alvzotw9ryo8r',
    'thread_mrdip0u5aw4ysi97',
  ];
  const refs = ids.map(shortThreadRef);
  assert.equal(new Set(refs).size, ids.length, `refs must be distinct, got ${JSON.stringify(refs)}`);
  for (const ref of refs) {
    assert.ok(!ref.startsWith('thread_'), `ref must drop the constant namespace prefix, got "${ref}"`);
  }
});

test('shortThreadRef strips only the thread_ namespace prefix', () => {
  assert.equal(shortThreadRef('thread_mrkmxgdfqquounc9'), 'mrkmxgdf');
  assert.equal(shortThreadRef('thread_eval_a2a'), 'eval_a2a');
  // Exactly ONE prefix is removed: a literal `thread_` inside the id is part of the id,
  // not a second namespace to strip. Repeated stripping would silently rewrite ids.
  assert.equal(shortThreadRef('thread_thread_x'), 'thread_x');
  // Ids that do not carry the namespace prefix are truncated as-is.
  assert.equal(shortThreadRef('source-thread-abc123'), 'source-t');
  assert.equal(shortThreadRef('short'), 'short');
});
