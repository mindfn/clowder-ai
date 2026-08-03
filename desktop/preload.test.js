// F273 — preload bridge contract tests (no Electron runtime required)

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { describe, test } = require('node:test');

function loadBridge({ readyResults = [] } = {}) {
  const exposed = {};
  const sent = [];
  const invoked = [];
  let readyAttempt = 0;
  const ipcRenderer = new EventEmitter();
  ipcRenderer.send = (channel, payload) => sent.push([channel, payload]);
  ipcRenderer.invoke = async (channel, payload) => {
    invoked.push([channel, payload]);
    if (channel === 'desktop-update:ready') {
      const result = readyResults[readyAttempt++] ?? { accepted: true };
      if (result instanceof Error) throw result;
      return result;
    }
    if (channel === 'desktop-update:settings:get') return { autoCheck: true };
    if (channel === 'desktop-update:settings:set-auto-check') return { autoCheck: payload };
    throw new Error(`Unexpected invoke channel: ${channel}`);
  };
  const contextBridge = {
    exposeInMainWorld(name, api) {
      exposed[name] = api;
    },
  };
  const source = readFileSync(path.join(__dirname, 'preload.js'), 'utf8');
  vm.runInNewContext(source, {
    require(id) {
      assert.equal(id, 'electron');
      return { contextBridge, ipcRenderer };
    },
  });
  return { bridge: exposed.desktopBridge, ipcRenderer, sent, invoked };
}

describe('desktop preload update bridge', () => {
  test('latches readiness intent until main delivers the committed document capability', async () => {
    const { bridge, ipcRenderer, invoked } = loadBridge();

    await bridge.updatePromptReady();
    assert.deepEqual(invoked, [], 'renderer intent must not request or mint document authority');

    ipcRenderer.emit('desktop-update:document-capability', {}, '');
    ipcRenderer.emit('desktop-update:document-capability', {}, { token: 'forged' });
    assert.deepEqual(invoked, [], 'malformed capability deliveries must be inert');

    ipcRenderer.emit('desktop-update:document-capability', {}, 'document-committed');
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(invoked, [['desktop-update:ready', 'document-committed']]);
  });

  test('accepts capability before readiness intent and signals each capability at most once', async () => {
    const { bridge, ipcRenderer, invoked } = loadBridge();

    ipcRenderer.emit('desktop-update:document-capability', {}, 'document-committed');
    ipcRenderer.emit('desktop-update:document-capability', {}, 'document-committed');
    assert.deepEqual(invoked, []);

    await bridge.updatePromptReady();
    await bridge.updatePromptReady();
    ipcRenderer.emit('desktop-update:document-capability', {}, 'document-committed');
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(invoked, [['desktop-update:ready', 'document-committed']]);
  });

  test('subscribes with cleanup and requests replay after renderer mount', async () => {
    const { bridge, ipcRenderer, sent, invoked } = loadBridge();
    const prompts = [];
    const unsubscribe = bridge.onUpdatePrompt((prompt) => prompts.push(prompt));

    ipcRenderer.emit('desktop-update:prompt', {}, { version: '0.12.0' });
    ipcRenderer.emit('desktop-update:document-capability', {}, 'document-1');
    await bridge.updatePromptReady();

    assert.equal(prompts.length, 1);
    assert.equal(prompts[0].version, '0.12.0');
    assert.deepEqual(invoked, [['desktop-update:ready', 'document-1']]);
    assert.deepEqual(sent, []);

    unsubscribe();
    ipcRenderer.emit('desktop-update:prompt', {}, { version: '0.13.0' });
    assert.equal(prompts.length, 1);
  });

  test('keeps readiness intent after rejection and signals a replacement capability once', async () => {
    const { bridge, ipcRenderer, sent, invoked } = loadBridge({
      readyResults: [{ accepted: false }, { accepted: true }],
    });

    ipcRenderer.emit('desktop-update:document-capability', {}, 'document-1');
    await bridge.updatePromptReady();
    await bridge.updatePromptReady();
    ipcRenderer.emit('desktop-update:document-capability', {}, 'document-2');
    ipcRenderer.emit('desktop-update:document-capability', {}, 'document-2');
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(invoked, [
      ['desktop-update:ready', 'document-1'],
      ['desktop-update:ready', 'document-2'],
    ]);
    assert.deepEqual(sent, [], 'the renderer-facing bridge must not expose a token-bearing send path');
  });

  test('retries the current capability after readiness invocation fails', async () => {
    const { bridge, ipcRenderer, invoked } = loadBridge({
      readyResults: [new Error('transient IPC failure'), { accepted: true }],
    });

    ipcRenderer.emit('desktop-update:document-capability', {}, 'document-1');
    await bridge.updatePromptReady();
    ipcRenderer.emit('desktop-update:document-capability', {}, 'document-1');
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(invoked, [
      ['desktop-update:ready', 'document-1'],
      ['desktop-update:ready', 'document-1'],
    ]);
  });

  test('a retired capability failure cannot clear the replacement capability marker', async () => {
    let rejectRetired;
    const retiredAttempt = new Promise((_, reject) => {
      rejectRetired = reject;
    });
    const { bridge, ipcRenderer, invoked } = loadBridge({
      readyResults: [retiredAttempt, { accepted: true }],
    });

    ipcRenderer.emit('desktop-update:document-capability', {}, 'document-1');
    const firstReady = bridge.updatePromptReady();
    ipcRenderer.emit('desktop-update:document-capability', {}, 'document-2');
    await new Promise((resolve) => setImmediate(resolve));

    rejectRetired(new Error('retired IPC failure'));
    await firstReady;
    ipcRenderer.emit('desktop-update:document-capability', {}, 'document-2');
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(invoked, [
      ['desktop-update:ready', 'document-1'],
      ['desktop-update:ready', 'document-2'],
    ]);
  });

  test('subscribes to main-owned update progress without exposing transfer controls', () => {
    const { bridge, ipcRenderer } = loadBridge();
    const snapshots = [];
    const unsubscribe = bridge.onUpdateProgress((snapshot) => snapshots.push(snapshot));
    const progress = {
      phase: 'downloading',
      version: '0.12.0',
      assetName: 'ClowderAI-Setup-0.12.0.exe',
      progress: 0.42,
    };

    ipcRenderer.emit('desktop-update:progress', {}, progress);
    ipcRenderer.emit('desktop-update:progress', {}, null);

    assert.deepEqual(JSON.parse(JSON.stringify(snapshots)), [progress, null]);
    assert.equal('cancelUpdateDownload' in bridge, false);
    assert.equal('pauseUpdateDownload' in bridge, false);

    unsubscribe();
    ipcRenderer.emit('desktop-update:progress', {}, progress);
    assert.equal(snapshots.length, 2);
  });

  test('admits only enumerated actions and never accepts a renderer URL', () => {
    const { bridge, sent } = loadBridge();

    bridge.sendUpdatePromptAction('download', '0.12.0');
    bridge.sendUpdatePromptAction('open-release', '0.12.0');

    assert.deepEqual(JSON.parse(JSON.stringify(sent)), [
      ['desktop-update:action', { action: 'download', version: '0.12.0' }],
      ['desktop-update:action', { action: 'open-release', version: '0.12.0' }],
    ]);
    assert.throws(() => bridge.sendUpdatePromptAction('open-url', 'https://evil.example'), /invalid/i);
    assert.equal('openExternal' in bridge, false);
    assert.equal('openUrl' in bridge, false);
  });

  test('exposes only typed automatic-update preference calls', async () => {
    const { bridge, invoked } = loadBridge();

    assert.deepEqual(await bridge.getUpdateSettings(), { autoCheck: true });
    assert.deepEqual(await bridge.setUpdateAutoCheck(false), { autoCheck: false });
    assert.deepEqual(invoked, [
      ['desktop-update:settings:get', undefined],
      ['desktop-update:settings:set-auto-check', false],
    ]);
    assert.throws(() => bridge.setUpdateAutoCheck('false'), /invalid/i);
  });
});
