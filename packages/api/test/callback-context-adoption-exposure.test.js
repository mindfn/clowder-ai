import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCallbackContextFixture } from './helpers/callback-context-fixture.js';

for (const [name, change] of Object.entries({
  'wrong invocation': { invocationId: 'foreign-child' },
  'wrong parent': { parentInvocationId: 'foreign-parent' },
  'wrong tenant': { userId: 'foreign-owner' },
  'wrong thread': { threadId: 'foreign-thread' },
  'wrong target': { catId: 'codex' },
  'terminal invocation': { status: 'succeeded' },
})) {
  test(`full context with ${name} preserves published history but withholds pending body`, async (t) => {
    const f = await createCallbackContextFixture(t);
    const visible = f.publish('published history stays readable');
    const admitted = await f.enqueue('private pending body');
    const original = await f.executions.get(f.auth.invocationId);
    f.executions.get = async () => ({ ...original, ...change });
    const result = await f.read({ readIntent: 'unread' });
    assert.equal(result.statusCode, 200, result.body);
    assert.ok(result.json().messages.some((m) => m.id === visible.id));
    assert.equal(result.body.includes(admitted.message.content), false);
    assert.deepEqual((await f.queue.getDurableEntry(f.threadId, admitted.entry.id)).targets, ['opus', 'codex']);
    assert.equal(f.messages.getById(admitted.message.id).lifecycle?.dispatchRefs?.length ?? 0, 0);
  });
}

test('History commit failure withholds pending body and retains admission for the same exact turn', async (t) => {
  const f = await createCallbackContextFixture(t);
  const admitted = await f.enqueue();
  const commit = f.messages.commitLifecycleAppendAdmission.bind(f.messages);
  f.messages.commitLifecycleAppendAdmission = async () => {
    throw new Error('owned History failure');
  };
  const failed = await f.read();
  assert.equal(failed.statusCode, 503, failed.body);
  assert.equal(failed.body.includes(admitted.message.content), false);
  assert.deepEqual((await f.queue.getDurableEntry(f.threadId, admitted.entry.id)).targets, ['opus', 'codex']);
  f.messages.commitLifecycleAppendAdmission = commit;
  assert.equal((await f.read()).statusCode, 200);
  assert.deepEqual((await f.queue.getDurableEntry(f.threadId, admitted.entry.id)).targets, ['codex']);
  assert.equal(f.messages.getById(admitted.message.id).lifecycle.dispatchRefs[0].statusMessageId, f.response.id);
});
