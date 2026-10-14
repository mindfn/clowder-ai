import assert from 'node:assert/strict';
import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { registerWorktrees } from '../src/domains/workspace/workspace-security.js';
import { dotProactiveFixture as fixture } from './helpers/f247-dot-proactive-fixture.js';

for (const failure of ['depth limit', 'partial preflight', 'second enqueue exception'] as const) {
  test(`complete dot fan-out remains retryable after ${failure}`, async () => {
    let blocked = true;
    const f = await fixture(
      failure === 'partial preflight'
        ? {
            routingDispatchPreflight: {
              preflight: async (input) => ({
                v: 1,
                ownerId: input.ownerId,
                observedAt: Date.now(),
                resolverState: 'fresh',
                targets: input.targetCatIds.map((targetCatId) => ({
                  targetCatId,
                  disposition: blocked && targetCatId === 'sonnet' ? 'rejected' : 'allowed',
                  reasons: [],
                  alternatives: [],
                })),
              }),
            },
          }
        : {},
    );
    const mediaRoot = await mkdtemp(join(tmpdir(), 'dot-retry-gallery-'));
    registerWorktrees([
      { id: 'dot-gallery-' + failure.replaceAll(' ', '-'), root: mediaRoot, branch: 'test', head: 'test' },
    ]);
    const image = join(mediaRoot, 'image.png');
    await writeFile(image, 'image');
    const requestContent =
      '请两只猫分别回答\n```cc_rich\n' +
      JSON.stringify({
        v: 1,
        blocks: [{ id: 'dot-question-image', kind: 'media_gallery', v: 1, items: [{ url: image }] }],
      }) +
      '\n```';
    const enqueue = f.queue.enqueue.bind(f.queue);
    if (failure === 'second enqueue exception')
      f.queue.enqueue = (input) => {
        if (blocked && input.targetCats.includes('sonnet')) throw new Error('second enqueue unavailable');
        return enqueue(input);
      };
    try {
      const thread = f.thread(failure);
      const fillerIds: string[] = [];
      if (failure === 'depth limit')
        for (let i = 0; i < 9; i++) {
          const result = enqueue({
            threadId: thread.id,
            userId: 'owner',
            ownerAuthProvenance: 'unknown',
            content: `other question ${i}`,
            source: 'agent',
            targetCats: ['codex'],
            callerCatId: 'other',
            intent: 'execute',
          });
          assert.ok(result.entry);
          fillerIds.push(result.entry.id);
        }
      const ask = () =>
        f.rpc({
          attempt_id: f.setup.attemptId,
          thread_id: thread.id,
          target_cat_ids: ['codex', 'sonnet'],
          content: requestContent,
          client_message_id: 'same-question',
        });
      for (let retry = 0; retry < 2; retry++) {
        const result = await ask();
        assert.equal(result.error?.data.reason, 'dot_ask_delivery_pending', JSON.stringify(result));
        if (retry === 0) await unlink(image);
        assert.equal(
          f.queue.listAutoExecute(thread.id).filter((entry) => entry.callerCatId === 'gpt-dot').length,
          0,
          'no subset may cross the execution boundary',
        );
      }
      const rootId = f.postResults[0].body.messageId;
      assert.ok(rootId);
      assert.equal(f.postResults[1].body.messageId, rootId);
      blocked = false;
      if (failure === 'depth limit') f.queue.remove(thread.id, 'owner', fillerIds[0]);
      const recovered = await ask();
      assert.equal(recovered.result.structuredContent.messageId, rootId, JSON.stringify(recovered));
      const children = f.queue.listAutoExecute(thread.id).filter((entry) => entry.callerCatId === 'gpt-dot');
      assert.deepEqual(children.flatMap((entry) => entry.targetCats).sort(), ['codex', 'sonnet']);
      assert.equal((await ask()).result.structuredContent.messageId, rootId);
      assert.equal(
        f.queue.listAutoExecute(thread.id).filter((entry) => entry.callerCatId === 'gpt-dot').length,
        2,
        'the same request must not re-dispatch either recipient',
      );
    } finally {
      await f.close();
      await rm(mediaRoot, { recursive: true, force: true });
    }
  });
}

test('complete coalesced fan-out is accepted without adding duplicate executions', async () => {
  const f = await fixture();
  try {
    const thread = f.thread('coalesced questions');
    const ask = (key: string) =>
      f.rpc({
        attempt_id: f.setup.attemptId,
        thread_id: thread.id,
        target_cat_ids: ['codex', 'sonnet'],
        content: `请两只猫分别回答 ${key}`,
        client_message_id: key,
      });
    const first = await ask('first');
    const second = await ask('second');
    assert.ok(first.result && second.result, JSON.stringify([first, second]));
    assert.notEqual(first.result.structuredContent.messageId, second.result.structuredContent.messageId);
    assert.deepEqual(second.result.structuredContent.routed, [], 'coalescing is accepted without a new route');
    assert.equal((await ask('second')).result.structuredContent.messageId, second.result.structuredContent.messageId);
    const children = f.queue.listAutoExecute(thread.id);
    assert.equal(children.length, 2);
    assert.ok(children.every((entry) => entry.mergedMessageIds.includes(second.result.structuredContent.messageId)));
  } finally {
    await f.close();
  }
});
