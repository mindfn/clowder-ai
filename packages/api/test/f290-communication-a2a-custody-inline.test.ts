import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DELEGATE, NEXT_CAT } from './f290-communication-a2a-custody-callback.fixture.js';
import { inlineCustodyFixture } from './f290-communication-a2a-custody-inline.fixture.js';
import { CAT } from './f290-communication-validation.host.js';

for (const defer of ['busy', 'pending', 'interrupted'] as const) {
  test(`actual callback creates a non-original private B turn whose text cannot escape through ${defer}`, async () => {
    const f = await inlineCustodyFixture('private', defer);
    try {
      const source = await f.run();
      assert.deepEqual(f.calls, [
        { catId: CAT, policy: 'collective_work' },
        { catId: DELEGATE, policy: 'collective_work' },
      ]);
      assert.deepEqual(source?.extra?.collectiveWorkDelegationV1?.targetCatIds, [DELEGATE]);
      assert.equal(source?.extra?.collectiveWorkDelegationV1?.taskId, f.task.id);
      assert.equal(
        f.queue.list(f.threadId, f.cafe.ownerUserId).length,
        0,
        'Non-original text does not create C home custody',
      );
    } finally {
      await f.close();
    }
  });
}

test('actual ordinary callback still reaches non-original B and defers its home text routing', async () => {
  const f = await inlineCustodyFixture('home', 'busy');
  try {
    const source = await f.run();
    assert.deepEqual(
      f.calls.map((call) => call.catId),
      [CAT, DELEGATE],
    );
    assert.ok(f.calls.every((call) => call.policy === undefined));
    assert.equal(source?.extra?.collectiveWorkDelegationV1, undefined);
    const entries = f.queue.list(f.threadId, f.cafe.ownerUserId);
    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0].targetCats, [NEXT_CAT]);
    assert.equal(entries[0].executionScope, undefined);
  } finally {
    await f.close();
  }
});

test('inline providers ignore ambient installer credentials and a live proxy without weakening the sandbox', async () => {
  const root = await mkdtemp(join(tmpdir(), 'f290-inline-ambient-'));
  const config = join(root, '.cat-cafe');
  await mkdir(config);
  const accounts = JSON.stringify({
    'installer-anthropic': { authType: 'api_key', clientId: 'anthropic', baseUrl: 'https://fixture.invalid' },
  });
  const credentials = JSON.stringify({ 'installer-anthropic': { apiKey: 'fixture-only-key' } });
  await writeFile(join(config, 'accounts.json'), accounts);
  await writeFile(join(config, 'credentials.json'), credentials);
  let connections = 0;
  const proxy = createServer((socket) => {
    connections++;
    socket.end();
  });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const address = proxy.address();
  assert.ok(address && typeof address !== 'string');
  const env = {
    CAT_CAFE_CONFIG_ROOT: fileURLToPath(new URL('../../../', import.meta.url)),
    CAT_CAFE_GLOBAL_CONFIG_ROOT: root,
    ANTHROPIC_PROXY_ENABLED: '1',
    ANTHROPIC_PROXY_PORT: String(address.port),
    CAT_CAFE_TEST_SANDBOX: '1',
  };
  const before = Object.fromEntries([...Object.keys(env), 'CAT_TEMPLATE_PATH'].map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  let f: Awaited<ReturnType<typeof inlineCustodyFixture>> | undefined;
  try {
    f = await inlineCustodyFixture('home', 'busy');
    await f.run();
    assert.deepEqual(
      f.calls.map((call) => call.catId),
      [CAT, DELEGATE],
    );
    assert.deepEqual(
      f.queue.list(f.threadId, f.cafe.ownerUserId).map((entry) => entry.targetCats),
      [[NEXT_CAT]],
    );
    assert.equal(connections, 0, 'Scripted providers must not probe the ambient proxy');
    assert.equal(await readFile(join(config, 'accounts.json'), 'utf8'), accounts);
    assert.equal(await readFile(join(config, 'credentials.json'), 'utf8'), credentials);
    await assert.rejects(readFile(join(config, 'proxy-upstreams.json')), { code: 'ENOENT' });
    const fixtureRoot = process.env.CAT_CAFE_CONFIG_ROOT;
    assert.ok(fixtureRoot && fixtureRoot !== env.CAT_CAFE_CONFIG_ROOT);
    await f.close();
    f = undefined;
    assert.equal(process.env.CAT_CAFE_CONFIG_ROOT, env.CAT_CAFE_CONFIG_ROOT);
    assert.equal(process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT, env.CAT_CAFE_GLOBAL_CONFIG_ROOT);
    assert.equal(process.env.CAT_TEMPLATE_PATH, before.CAT_TEMPLATE_PATH);
    await assert.rejects(stat(fixtureRoot), { code: 'ENOENT' });
  } finally {
    await f?.close();
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await new Promise<void>((resolve, reject) => proxy.close((error) => (error ? reject(error) : resolve())));
    await rm(root, { recursive: true, force: true });
  }
});
