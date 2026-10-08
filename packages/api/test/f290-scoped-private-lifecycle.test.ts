import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import { TranscriptReader } from '../src/domains/cats/services/session/TranscriptReader.js';
import { sessionTranscriptRoutes } from '../src/routes/session-transcript.js';
import { routeCustodyFixture } from './f290-communication-a2a-custody-route.fixture.js';

for (const scope of ['private', 'delegated-private'] as const) {
  test(`${scope} real route records exact Work and native session, reloads owner trajectory, preserves home custody`, async () => {
    const f = await routeCustodyFixture(scope, 'busy');
    const app = Fastify();
    try {
      const chains = f.sessionPorts.sessionChainStore;
      const home = chains.create({
        userId: f.cafe.ownerUserId,
        threadId: f.threadId,
        catId: f.catId,
        cliSessionId: 'PRIVATE_HOME_CANARY',
      });
      const events = await f.run();
      assert.deepEqual(
        f.calls.map((call) => call.catId),
        [f.catId],
      );
      assert.equal(f.calls[0].policy, 'collective_work');
      const record = chains.getChain(f.catId, f.threadId, f.cafe.ownerUserId).find((item) => item.scopedInvocation);
      assert.ok(record?.scopedInvocation?.executionScope === 'collective-work', JSON.stringify(events));
      assert.equal(record.scopedInvocation.taskId, f.task.id);
      assert.equal(record.status, 'sealed');
      assert.ok(record.cliSessionId);
      assert.notEqual(record.cliSessionId, 'PRIVATE_HOME_CANARY');
      assert.equal(chains.getActive(f.catId, f.threadId, f.cafe.ownerUserId)?.id, home.id);
      assert.equal(
        (await f.sessionPorts.turnExecutionStore.get(record.scopedInvocation.invocationId))?.status,
        'succeeded',
      );
      await app.register(sessionTranscriptRoutes, {
        sessionChainStore: chains,
        turnExecutionStore: f.sessionPorts.turnExecutionStore,
        invocationRecordStore: { get: () => null },
        threadStore: f.threads,
        transcriptReader: new TranscriptReader({ dataDir: join(f.cafe.dataDirectory, 'scoped-sessions') }),
      });
      const response = await app.inject({
        method: 'GET',
        url: `/api/threads/${f.threadId}/invocations`,
        headers: { 'x-cat-cafe-user': f.cafe.ownerUserId },
      });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json().invocations[0].invocationId, record.scopedInvocation.invocationId);
      assert.equal(response.json().invocations[0].status, 'done');
      assert.equal(
        f.queue.size(f.threadId, f.cafe.ownerUserId),
        0,
        'private provider prose cannot silently grant another Cat work',
      );
    } finally {
      await app.close();
      await f.close();
    }
  });
}
