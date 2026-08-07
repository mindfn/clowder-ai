import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';

const TEST_CAT_ID = 'capacity-owner-test';

describe('#1208 invocation-owned capacity snapshot', () => {
  let resolveInvocationCapacitySnapshot;
  let SessionChainStore;
  let savedConfigs;

  before(async () => {
    ({ resolveInvocationCapacitySnapshot } = await import(
      '../../dist/domains/cats/services/agents/invocation/invocation-capacity-snapshot.js'
    ));
    ({ SessionChainStore } = await import('../../dist/domains/cats/services/stores/ports/SessionChainStore.js'));
    savedConfigs = catRegistry.getAllConfigs();
    catRegistry.reset();
    catRegistry.register(TEST_CAT_ID, {
      id: TEST_CAT_ID,
      name: TEST_CAT_ID,
      displayName: 'Capacity Owner Test',
      avatar: '🐱',
      color: { primary: '#000', secondary: '#fff' },
      mentionPatterns: ['@capacity-owner-test'],
      clientId: 'openai',
      accountRef: 'codex-oauth',
      provider: 'openai',
      defaultModel: 'gpt-5.4',
      contextWindow: 200_000,
      mcpSupport: false,
      roleDescription: 'test',
      personality: 'test',
    });
  });

  after(() => {
    catRegistry.reset();
    for (const [id, config] of Object.entries(savedConfigs)) catRegistry.register(id, config);
  });

  it('loads one pre-provider snapshot and applies the active-session pin', async () => {
    const service = {
      async *invoke() {},
      contextCapability() {
        return {
          provider: 'openai',
          carrier: 'exec_json',
          reportsRuntimeWindow: true,
          authoritativeUsage: true,
          nativeWindowControl: true,
          nativeCompressionControl: true,
          observesCompression: true,
          reason: 'test carrier',
        };
      },
    };
    const store = new SessionChainStore();
    const first = await resolveInvocationCapacitySnapshot({
      catId: TEST_CAT_ID,
      threadId: 'thread-capacity-owner',
      service,
      sessionChainStore: store,
    });
    assert.equal(first.capacity.windowTokens, 200_000);
    assert.equal(first.capacity.bindingKey.carrier, 'exec_json');

    const record = store.create({
      cliSessionId: 'cli-capacity-owner',
      threadId: 'thread-capacity-owner',
      catId: TEST_CAT_ID,
      userId: 'user-1',
    });
    const smallerPin = {
      ...first.pin,
      windowTokens: 180_000,
      inputCeilingTokens: 164_000,
    };
    store.update(record.id, { capacityPin: smallerPin });

    const resumed = await resolveInvocationCapacitySnapshot({
      catId: TEST_CAT_ID,
      threadId: 'thread-capacity-owner',
      service,
      sessionChainStore: store,
    });
    assert.equal(resumed.capacity.windowTokens, 180_000, 'same binding must not expand past the session pin');
    assert.deepEqual(resumed.pin, smallerPin);
  });
});
