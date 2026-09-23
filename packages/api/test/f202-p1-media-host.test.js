import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  FileMediaEntitlementPort,
  MediaEntitlementLedger,
  MemoryMediaEntitlementPort,
} from '../dist/domains/messaging/media-entitlements.js';
import { FileMessagingMediaLedger } from '../dist/domains/messaging/media-ledger.js';
import { createMessagingBrokerHandlers } from '../dist/domains/plugin/host-broker/messaging-handler.js';
import { PluginMediaReadService } from '../dist/domains/plugin/host-surface/plugin-media-host.js';
import {
  createExternalRuntimeHarness,
  EXTERNAL_INSTANCE_ID,
  externalCandidate,
  externalManifest,
} from './plugin-external-runtime-helpers.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'f202-p1-media-'));
  const ledger = new FileMessagingMediaLedger(join(root, 'media'));
  const port = new FileMediaEntitlementPort(join(root, 'entitlements.json'));
  const entitlements = new MediaEntitlementLedger(port, { now: () => 1000 });
  const media = new PluginMediaReadService({ ledger, entitlements });
  return { root, ledger, port, entitlements, media };
}

const allowed = { pluginInstanceId: 'pi_a', effectiveGrants: ['media.read'] };
const other = { pluginInstanceId: 'pi_b', effectiveGrants: ['media.read'] };
const ungranted = { pluginInstanceId: 'pi_a', effectiveGrants: [] };
const deliveryScope = { kind: 'delivery', deliveryId: 'delivery-1' };

async function rejectsCode(promise, code) {
  await assert.rejects(promise, (error) => error?.code === code);
}

test('hmr registration is private, random, persistent and can import an existing file', async () => {
  const { root, ledger } = await fixture();
  const bytes = Buffer.from('private-media-bytes');
  const path = join(root, 'import.bin');
  await writeFile(path, bytes);
  const first = await ledger.register(bytes, { ownerInstanceId: 'pi_a', mimeType: 'image/png' });
  const second = await ledger.register({ path }, { ownerInstanceId: 'pi_a', importKey: 'pi_a:event:element' });
  const third = await ledger.register(bytes, { locator: '/untrusted/path', hmrId: 'hmr_forged' });
  assert.match(first, /^hmr_[A-Za-z0-9_-]{22,}$/);
  assert.notEqual(first, second);
  assert.equal(
    (await new FileMessagingMediaLedger(join(root, 'media')).readChunk(first, 0, 512)).dataBase64,
    bytes.toString('base64'),
  );
  assert.equal(JSON.stringify({ first, second }).includes(path), false);
  assert.equal((await ledger.readChunk(third, 0, 512)).dataBase64, bytes.toString('base64'));
});

test('grant/read uses bounded chunks, terminal empty chunk and validates offsets and limits', async () => {
  const { ledger, entitlements, media } = await fixture();
  const reference = await ledger.register(Buffer.from('abcde'), { ownerInstanceId: 'pi_a' });
  await entitlements.grant({ instanceId: 'pi_a', scope: deliveryScope, elementId: 'media-1', hmrId: reference });
  assert.deepEqual(await media.read(allowed, { reference, offset: 0, limit: 2 }), {
    offset: 0,
    dataBase64: Buffer.from('ab').toString('base64'),
    nextOffset: 2,
    done: false,
  });
  assert.deepEqual(await media.read(allowed, { reference, offset: 4, limit: 2 }), {
    offset: 4,
    dataBase64: Buffer.from('e').toString('base64'),
    done: true,
  });
  assert.deepEqual(await media.read(allowed, { reference, offset: 5, limit: 2 }), {
    offset: 5,
    dataBase64: '',
    done: true,
  });
  await rejectsCode(media.read(allowed, { reference, offset: 6, limit: 2 }), 'VALIDATION');
  await rejectsCode(media.read(allowed, { reference, offset: 0, limit: 0 }), 'VALIDATION');
  await rejectsCode(media.read(allowed, { reference, offset: 0, limit: 524289 }), 'VALIDATION');
});

test('four entitlement failures use indistinguishable code and message; missing capability is distinct', async () => {
  const { ledger, entitlements, media } = await fixture();
  const reference = await ledger.register(Buffer.from('secret'), { ownerInstanceId: 'pi_a' });
  const unknown = `hmr_${'z'.repeat(32)}`;
  const messages = [];
  for (const [ctx, ref] of [
    [allowed, reference],
    [allowed, unknown],
    [other, reference],
  ]) {
    await assert.rejects(media.read(ctx, { reference: ref, offset: 0, limit: 1 }), (error) => {
      assert.equal(error.code, 'MEDIA_ACCESS_DENIED');
      messages.push(error.message);
      return true;
    });
  }
  const grant = await entitlements.grant({
    instanceId: 'pi_a',
    scope: deliveryScope,
    elementId: 'media-1',
    hmrId: reference,
  });
  await entitlements.revoke({ grantId: grant.grantId }, 'delivery_settled');
  await assert.rejects(media.read(allowed, { reference, offset: 0, limit: 1 }), (error) => {
    assert.equal(error.code, 'MEDIA_ACCESS_DENIED');
    messages.push(error.message);
    return true;
  });
  assert.equal(new Set(messages).size, 1);
  await rejectsCode(media.read(ungranted, { reference, offset: 0, limit: 1 }), 'PERMISSION');
});

test('audit is durable, append-only, sanitized, and revoke is idempotent', async () => {
  const { root, entitlements } = await fixture();
  const grant = await entitlements.grant({
    instanceId: 'pi_a',
    scope: deliveryScope,
    elementId: 'media-1',
    hmrId: 'hmr_abc',
  });
  assert.equal(await entitlements.isEntitled('pi_a', 'hmr_abc'), true);
  await entitlements.revoke({ grantId: grant.grantId }, 'delivery_settled');
  await entitlements.revoke({ grantId: grant.grantId }, 'delivery_settled');
  assert.equal(await entitlements.isEntitled('pi_a', 'hmr_abc'), false);
  const persisted = JSON.parse(await readFile(join(root, 'entitlements.json'), 'utf8'));
  assert.equal(persisted.audit.length, 2);
  assert.equal(persisted.audit[0].pluginInstanceId, 'pi_a');
  assert.equal(persisted.audit[0].deliveryId, 'delivery-1');
  assert.equal(persisted.audit[1].revokeReason, 'delivery_settled');
  assert.ok(persisted.audit[0].grantedAt <= persisted.audit[1].revokedAt);
  assert.equal(JSON.stringify(persisted).includes('private-media-bytes'), false);
  assert.equal(
    await new MediaEntitlementLedger(new FileMediaEntitlementPort(join(root, 'entitlements.json'))).isEntitled(
      'pi_a',
      'hmr_abc',
    ),
    false,
  );
});

test('failed audit persistence fails closed and no grant becomes readable', async () => {
  const port = new MemoryMediaEntitlementPort();
  port.failNextSave = true;
  const entitlements = new MediaEntitlementLedger(port);
  await assert.rejects(
    entitlements.grant({ instanceId: 'pi_a', scope: deliveryScope, elementId: 'media-1', hmrId: 'hmr_abc' }),
  );
  assert.equal(await entitlements.isEntitled('pi_a', 'hmr_abc'), false);
});

test('a write that persists then reports failure still poisons reads until restart', async () => {
  const memory = new MemoryMediaEntitlementPort();
  const port = {
    load: () => memory.load(),
    async save(state) {
      await memory.save(state);
      throw new Error('directory sync failed after rename');
    },
  };
  const entitlements = new MediaEntitlementLedger(port);
  await assert.rejects(
    entitlements.grant({ instanceId: 'pi_a', scope: deliveryScope, elementId: 'media-1', hmrId: 'hmr_abc' }),
  );
  assert.equal((await memory.load()).grants.length, 1, 'the port did expose the new snapshot');
  assert.equal(await entitlements.isEntitled('pi_a', 'hmr_abc'), false);
  await assert.rejects(
    entitlements.grant({ instanceId: 'pi_a', scope: deliveryScope, elementId: 'media-1', hmrId: 'hmr_abc' }),
  );
});

test('snapshot grants expire, while an independent delivery grant remains readable', async () => {
  const port = new MemoryMediaEntitlementPort();
  let now = 1000;
  const entitlements = new MediaEntitlementLedger(port, { now: () => now });
  const snapshot = await entitlements.grant({
    instanceId: 'pi_a',
    scope: { kind: 'snapshot', sessionId: 'session-1' },
    elementId: 'media-1',
    hmrId: 'hmr_abc',
    expiresAt: 1100,
  });
  const delivery = await entitlements.grant({
    instanceId: 'pi_a',
    scope: deliveryScope,
    elementId: 'media-1',
    hmrId: 'hmr_abc',
  });
  assert.equal(await entitlements.isEntitled('pi_a', 'hmr_abc'), true);
  now = 1100;
  await entitlements.revoke({ grantId: delivery.grantId }, 'delivery_settled');
  assert.equal(await entitlements.isEntitled('pi_a', 'hmr_abc'), false);
  assert.equal(snapshot.scope.kind, 'snapshot');
});

test('a corrupt entitlement audit snapshot fails closed without leaking store details', async () => {
  const { root, ledger, media } = await fixture();
  const reference = await ledger.register(Buffer.from('secret'), { ownerInstanceId: 'pi_a' });
  await writeFile(join(root, 'entitlements.json'), '{invalid');
  await assert.rejects(media.read(allowed, { reference, offset: 0, limit: 1 }), (error) => {
    assert.equal(error.code, 'MEDIA_ACCESS_DENIED');
    assert.equal(error.message, 'Media access denied');
    return true;
  });
});

test('a valid-shaped snapshot missing its grant audit fails closed', async () => {
  const { root, ledger, entitlements, media } = await fixture();
  const reference = await ledger.register(Buffer.from('secret'));
  await entitlements.grant({ instanceId: 'pi_a', scope: deliveryScope, elementId: 'media-1', hmrId: reference });
  const path = join(root, 'entitlements.json');
  const state = JSON.parse(await readFile(path, 'utf8'));
  state.audit = [];
  await writeFile(path, JSON.stringify(state));
  await assert.rejects(media.read(allowed, { reference, offset: 0, limit: 1 }), (error) => {
    assert.equal(error.code, 'MEDIA_ACCESS_DENIED');
    assert.equal(error.message, 'Media access denied');
    return true;
  });
});

test('a same-length change to Host-owned bytes is rejected rather than silently served', async () => {
  const { root, ledger, entitlements, media } = await fixture();
  const reference = await ledger.register(Buffer.from('abc'), { ownerInstanceId: 'pi_a' });
  await entitlements.grant({ instanceId: 'pi_a', scope: deliveryScope, elementId: 'media-1', hmrId: reference });
  assert.equal((await media.read(allowed, { reference, offset: 0, limit: 2 })).dataBase64, 'YWI=');
  await writeFile(join(root, 'media', 'blobs', reference), Buffer.from('xyz'));
  await assert.rejects(media.read(allowed, { reference, offset: 0, limit: 2 }), (error) => {
    assert.equal(error.code, 'MEDIA_ACCESS_DENIED');
    assert.equal(error.message, 'Media access denied');
    return true;
  });
});

test('broker exposes the frozen media.read row with contract validation', async () => {
  const { ledger, entitlements, media } = await fixture();
  const reference = await ledger.register(Buffer.from('abc'), { ownerInstanceId: 'pi_a' });
  await entitlements.grant({ instanceId: 'pi_a', scope: deliveryScope, elementId: 'media-1', hmrId: reference });
  const handler = createMessagingBrokerHandlers({ media }).find((candidate) => candidate.method === 'media.read');
  assert.ok(handler);
  const input = { reference, offset: 0, limit: 2 };
  assert.equal(handler.validateInput(input).valid, true);
  assert.equal(handler.validateInput({ ...input, limit: 0 }).valid, false);
  const result = await handler.dispatch(allowed, input);
  assert.equal(handler.validateResult(result), true);
  assert.equal(result.nextOffset, 2);
});

test('admitted external Broker invokes media.read and gates the capability before bytes', async () => {
  const { root, ledger, entitlements, media } = await fixture();
  const reference = await ledger.register(Buffer.from('abc'), { ownerInstanceId: EXTERNAL_INSTANCE_ID });
  await entitlements.grant({
    instanceId: EXTERNAL_INSTANCE_ID,
    scope: deliveryScope,
    elementId: 'media-1',
    hmrId: reference,
  });
  const manifest = externalManifest();
  manifest.features[0].capabilities = ['media.read'];
  const harness = await createExternalRuntimeHarness({
    rootDir: join(root, 'package'),
    manifest,
    effectiveGrants: ['media.read'],
    methods: createMessagingBrokerHandlers({ media }),
  });
  const connection = await harness.broker.openExternalConnection(EXTERNAL_INSTANCE_ID);
  const binding = await connection.hello(externalCandidate());
  await connection.ready({ bindingNonce: binding.bindingNonce });
  assert.deepEqual(await connection.call('media.read', { reference, offset: 0, limit: 2 }), {
    offset: 0,
    dataBase64: 'YWI=',
    nextOffset: 2,
    done: false,
  });
  assert.equal((await harness.brokerStore.snapshot()).calls.length, 0, 'media.read has no Broker call ledger');
});

test('contract permission matrix includes the media.read L1 row without a Host-owned copy', async () => {
  const { contractPermissionEntries } = await import('./plugin-m0d-host-control-adapter.js');
  assert.deepEqual(
    contractPermissionEntries().find((entry) => entry.capability === 'media.read'),
    {
      capability: 'media.read',
      layer: 'L1',
      firstPartyPreset: true,
    },
  );
});
