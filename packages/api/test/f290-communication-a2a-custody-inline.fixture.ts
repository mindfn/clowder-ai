import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { _resetCachedConfig } from '../src/config/cat-config-loader.js';
import { AgentRegistry } from '../src/domains/cats/services/agents/registry/AgentRegistry.js';
import { callbackCustodyFixture, DELEGATE, NEXT_CAT } from './f290-communication-a2a-custody-callback.fixture.js';
import type { DeferCase } from './f290-communication-a2a-custody-route.fixture.js';
import { CAT } from './f290-communication-validation.host.js';
import { createIsolatedTemplateRoot } from './helpers/isolated-template-root.js';
import { scriptedSessionInit } from './helpers/scoped-test-sessions.js';

/** Real callback admission and independent Queue receiver; no inline worklist or custody mirror. */
export async function inlineCustodyFixture(scope: 'private' | 'home', defer: DeferCase) {
  const config = createIsolatedTemplateRoot(
    tmpdir(),
    fileURLToPath(new URL('../../../cat-template.json', import.meta.url)),
  );
  const env = {
    CAT_CAFE_CONFIG_ROOT: config.root,
    CAT_CAFE_GLOBAL_CONFIG_ROOT: config.root,
    CAT_TEMPLATE_PATH: config.templatePath,
  };
  const before = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  _resetCachedConfig();
  const restoreConfig = () => {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    _resetCachedConfig();
    config.cleanup();
  };
  try {
    return await createInlineCustodyFixture(scope, defer, restoreConfig);
  } catch (error) {
    restoreConfig();
    throw error;
  }
}

async function createInlineCustodyFixture(scope: 'private' | 'home', defer: DeferCase, restoreConfig: () => void) {
  let f: Awaited<ReturnType<typeof callbackCustodyFixture>>;
  const calls: { catId: string; policy?: string }[] = [];
  const agents = new AgentRegistry();
  agents.register(DELEGATE, {
    supportsToolExecutionPolicy: () => true,
    async *invoke(prompt, options) {
      calls.push({ catId: DELEGATE, policy: options?.toolExecutionPolicy?.mode });
      yield* scriptedSessionInit(DELEGATE, prompt, options);
      yield {
        type: 'text',
        catId: DELEGATE,
        content: `@${NEXT_CAT}\nFixture independently queued B output`,
        timestamp: Date.now(),
      };
      if (defer === 'interrupted')
        f.tracker.cancel(threadId, DELEGATE, f.cafe.ownerUserId, new Error('Fixture B interruption'));
      yield { type: 'done', catId: DELEGATE, timestamp: Date.now() };
    },
  });
  f = await callbackCustodyFixture(agents);
  const threadId =
    scope === 'private' ? f.task.threadId : f.threads.create(f.cafe.ownerUserId, 'Ordinary queued relay').id;
  if (scope === 'home')
    f.tracker.startAll(threadId, [DELEGATE, NEXT_CAT], f.cafe.ownerUserId, 'fixture-busy-recipients');
  return {
    ...f,
    calls,
    threadId,
    async run() {
      const auth = scope === 'private' ? f.auth : await f.registry.create(f.cafe.ownerUserId, CAT, threadId);
      const response = await f.post(auth, { content: 'Verified first-hop queued relay', targetCats: [DELEGATE] });
      assert.equal(response.statusCode, 200, response.body);
      const source = f.messages.getById(response.json().messageId);
      assert.ok(source);
      const entry = f.queue.list(threadId, f.cafe.ownerUserId).find((entry) => entry.payload.messageId === source.id);
      assert.ok(entry);
      f.tracker.complete(threadId, DELEGATE);
      await f.processor.progressOwnedCarrier(entry, DELEGATE);
      const deadline = Date.now() + 5000;
      while (!calls.length || f.tracker.has(threadId, DELEGATE)) {
        if (Date.now() >= deadline) assert.fail('Independent Queue receiver did not finish');
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      return f.messages.getById(source.id);
    },
    async close() {
      try {
        f.tracker.cancelAll(threadId);
        await f.close();
      } finally {
        restoreConfig();
      }
    },
  };
}
