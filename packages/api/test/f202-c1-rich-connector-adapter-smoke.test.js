import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { parse } from 'yaml';
import { projectEnvelope } from '../dist/domains/messaging/envelope.js';
import {
  HostInventoryControlPlane,
  LocalPluginPackageAdmission,
  MemoryPluginInventoryStore,
  packageDirectoryName,
} from '../dist/domains/plugin/index.js';
import { renderAllRichBlocksPlaintext } from '../dist/infrastructure/connectors/rich-block-plaintext.js';

const execFile = promisify(execFileCallback);
const archiveDirectory = process.env.F202_W25PH_ARCHIVE_DIR;
const releases = [
  {
    name: 'dingtalk',
    sha: 'ccc76383f26b541bc53cec1276b3edc88caa9d67332ce5a2459a93e50ff45bbc',
    factory: 'createDingTalkPluginModule',
    mode: 'rich',
  },
  {
    name: 'feishu',
    sha: 'b576a448a4c346854dc03f023274851f0ea66a9f69b19267fca9903739f1d894',
    factory: 'createFeishuPluginModule',
    mode: 'rich',
  },
  {
    name: 'wecom-agent',
    sha: '51aa99306c92d6e2d96811e873d2c6366a13b6379c300b1c607bc2d2076f2c4d',
    factory: 'createWeComAgentPluginModule',
    mode: 'text',
  },
  {
    name: 'wecom-bot',
    sha: 'c8c54ecb1bbcd871a4108ad43a8672d4d8368c46d25e908ee5d58fbb6e2a6612',
    factory: 'createWeComBotPluginModule',
    mode: 'rich',
  },
  {
    name: 'weixin',
    sha: '7e2e54a9666d8e5e6646c039f6b84bba75e9865b9e6c8b7e82463f75ff55c360',
    factory: 'createWeixinPluginModule',
    mode: 'text',
  },
  {
    name: 'xiaoyi',
    sha: '207631fcfc4d343b9f43260e3a9b213f136b6fd4f31336cccaed6b047585b6bf',
    factory: 'createXiaoyiPluginModule',
    mode: 'text',
  },
];

function archivePath(release) {
  return join(
    archiveDirectory,
    `clowder-ai-connector-${release.name}-0.1.0-alpha.0-darwin-arm64-${release.sha.slice(0, 12)}.tgz`,
  );
}

async function admitAndLoad(release, root) {
  const archive = archivePath(release);
  const bytes = await readFile(archive);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), release.sha, `${release.name} approved artifact`);

  const packagesRoot = join(root, 'packages');
  const store = new MemoryPluginInventoryStore();
  const inventory = new HostInventoryControlPlane(store, {
    createInstanceId: () => `pi_${release.name}`,
    now: () => 12_000,
  });
  const admission = new LocalPluginPackageAdmission({
    inventory,
    packagesRoot,
    grantPolicy: (manifest) => manifest.features.flatMap((feature) => [...feature.capabilities]),
  });
  const installed = await admission.install({ kind: 'local-archive', path: archive });
  const inventoryRow = (await store.snapshot()).packages.find(
    ({ packageDigest }) => packageDigest === installed.packageDigest,
  );
  assert.equal(inventoryRow?.provenance.dependencyClosure, 'shipped');
  const admittedArchive = join(packagesRoot, packageDirectoryName(installed.packageDigest), 'package.tgz');
  await execFile('tar', ['-xzf', admittedArchive, '-C', root]);
  const packageRoot = await realpath(join(root, 'package'));
  const manifest = parse(await readFile(join(packageRoot, 'plugin.yaml'), 'utf8'));
  const entrypoint = await realpath(join(packageRoot, manifest.runtime.entrypoint));
  assert.ok(entrypoint.startsWith(`${packageRoot}/`), 'runtime entrypoint must stay inside admitted package');
  const moduleNamespace = await import(pathToFileURL(entrypoint).href);
  assert.equal(typeof moduleNamespace[release.factory], 'function');
  return { manifest, factory: moduleNamespace[release.factory], packageRoot };
}

function storedMessage(name, blocks = []) {
  return {
    id: `message-${name}`,
    threadId: 'thread-1',
    userId: 'owner-1',
    catId: 'opus',
    content: 'rich reply',
    mentions: [],
    timestamp: 1_800_000_000_000,
    ...(blocks.length === 0 ? {} : { extra: { rich: { v: 1, blocks } } }),
  };
}

const card = { id: 'card-1', kind: 'card', v: 1, title: 'Approval', bodyMarkdown: 'Review the proposal' };
const checklist = { id: 'checklist-1', kind: 'checklist', v: 1, title: 'Steps', items: [] };

function adapterProbe() {
  const calls = [];
  const outbound = Object.fromEntries(
    ['sendRichMessage', 'sendReply', 'sendFormattedReply', 'sendMedia', 'onDeliveryBatchDone'].map((method) => [
      method,
      async (...args) => {
        calls.push({ method, args });
      },
    ]),
  );
  return {
    calls,
    runtime: {
      start: async () => undefined,
      stop: async () => undefined,
      outbound,
    },
  };
}

async function deliver(release, factory, manifest, blocks, calls) {
  const subscribed = [];
  const runtime = adapterProbe();
  const host = {
    config: {
      get: async (key) =>
        ({
          appKey: 'app-key',
          appId: 'app-id',
          corpId: 'corp-id',
          agentId: 'agent-id',
          botId: 'bot-id',
          accessKey: 'access-key',
        })[key],
    },
    secrets: { get: async () => 'fixture-secret' },
    state: { get: async () => null, set: async () => undefined },
    threads: { listBindings: async () => [{ threadId: 'thread-1', key: 'external-1' }] },
    messaging: {
      subscribe: async (input) => {
        subscribed.push(input);
        return { subscriptionId: 'sub-1' };
      },
      unsubscribe: async () => undefined,
    },
    log: () => undefined,
  };
  const active = await factory(() => runtime.runtime)
    .create(manifest)
    .start(host);
  try {
    assert.deepEqual(
      subscribed.map(({ threadId }) => threadId),
      ['thread-1'],
    );
    const stored = storedMessage(release.name, blocks);
    const envelope = projectEnvelope(stored);
    await active.actions[`${release.name}.outbound`]({
      deliveryId: `delivery-${release.name}`,
      threadId: 'thread-1',
      envelope,
    });
    calls.push({ stored, envelope, adapterCalls: runtime.calls });
  } finally {
    await active.stop();
  }
}

for (const release of releases) {
  test(`${release.name}: approved artifact reaches adapter with and without Host rich blocks`, async (context) => {
    if (!archiveDirectory) {
      context.skip(`set F202_W25PH_ARCHIVE_DIR; ${release.name} requires SHA-256 ${release.sha}`);
      return;
    }
    try {
      await access(archivePath(release));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      context.skip(`${release.name} artifact absent; requires SHA-256 ${release.sha}`);
      return;
    }

    const root = await mkdtemp(join(tmpdir(), `f202-w25ph-${release.name}-`));
    try {
      const { manifest, factory } = await admitAndLoad(release, root);
      const deliveries = [];
      await deliver(release, factory, manifest, [card, checklist], deliveries);
      await deliver(release, factory, manifest, [], deliveries);
      assert.equal(deliveries.length, 2);
      const [rich, plain] = deliveries;
      assert.deepEqual(
        rich.envelope.payload.elements.map(({ kind }) => kind),
        ['text', 'rich_block', 'rich_block'],
      );
      assert.deepEqual(
        rich.envelope.payload.elements.slice(1).map(({ payload }) => payload),
        [card, checklist],
      );
      const text = rich.envelope.payload.elements[0].payload.text;
      if (release.mode === 'rich') {
        assert.deepEqual(
          rich.adapterCalls.map(({ method }) => method),
          ['sendRichMessage'],
        );
        const [externalId, sentText, sentBlocks] = rich.adapterCalls[0].args;
        assert.equal(externalId, 'external-1');
        assert.ok(sentText.includes(text));
        assert.deepEqual(sentBlocks, [card, checklist]);
        assert.equal(JSON.stringify(sentBlocks), JSON.stringify([card, checklist]));
        assert.deepEqual(
          plain.adapterCalls.map(({ method }) => method),
          ['sendFormattedReply'],
        );
        assert.ok(plain.adapterCalls[0].args[1].body.includes(text));
      } else {
        assert.deepEqual(
          rich.adapterCalls.filter(({ method }) => method !== 'onDeliveryBatchDone').map(({ method }) => method),
          ['sendReply'],
        );
        const sentText = rich.adapterCalls[0].args[1];
        assert.ok(sentText.includes(text));
        assert.ok(sentText.endsWith(`\n\n${renderAllRichBlocksPlaintext([card, checklist])}`));
        // W2-5f is still open: current packages prepend actor.id ("opus" here),
        // whereas the old Host used the display-name/emoji prefix. Do not count it as parity.
        if (release.name === 'wecom-agent') {
          assert.deepEqual(
            plain.adapterCalls.map(({ method }) => method),
            ['sendFormattedReply'],
          );
          assert.ok(plain.adapterCalls[0].args[1].body.includes(text));
        } else {
          assert.deepEqual(
            plain.adapterCalls.filter(({ method }) => method !== 'onDeliveryBatchDone').map(({ method }) => method),
            ['sendReply'],
          );
          assert.ok(plain.adapterCalls[0].args[1].includes(text));
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test('an invalid historical Host block degrades before reaching the adapter', async (context) => {
  const release = releases.find(({ name }) => name === 'feishu');
  if (!archiveDirectory) {
    context.skip(`set F202_W25PH_ARCHIVE_DIR; feishu requires SHA-256 ${release.sha}`);
    return;
  }
  try {
    await access(archivePath(release));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    context.skip(`feishu artifact absent; requires SHA-256 ${release.sha}`);
    return;
  }
  const root = await mkdtemp(join(tmpdir(), 'f202-w25ph-degraded-'));
  try {
    const { manifest, factory } = await admitAndLoad(release, root);
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warnings.push(args);
    const deliveries = [];
    try {
      await deliver(release, factory, manifest, [{ ...card, v: 2 }], deliveries);
    } finally {
      console.warn = originalWarn;
    }
    const [{ envelope, adapterCalls }] = deliveries;
    assert.deepEqual(
      envelope.payload.elements.map(({ kind }) => kind),
      ['text', 'text'],
    );
    assert.match(envelope.payload.elements[1].payload.text, /card/);
    assert.equal(warnings[0][1].reason, 'invalid_shape');
    assert.deepEqual(
      adapterCalls.map(({ method }) => method),
      ['sendFormattedReply'],
    );
    assert.equal(adapterCalls[0].args[1].body, 'rich reply\n\n[card: Approval]');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
