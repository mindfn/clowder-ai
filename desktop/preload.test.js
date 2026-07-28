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
  let registration = 0;
  let readyAttempt = 0;
  const ipcRenderer = new EventEmitter();
  ipcRenderer.send = (channel, payload) => sent.push([channel, payload]);
  ipcRenderer.invoke = async (channel, payload) => {
    invoked.push([channel, payload]);
    if (channel === 'desktop-update:register') return `document-${++registration}`;
    if (channel === 'desktop-update:ready') {
      return readyResults[readyAttempt++] ?? { accepted: true };
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
  test('subscribes with cleanup and requests replay after renderer mount', async () => {
    const { bridge, ipcRenderer, sent, invoked } = loadBridge();
    const prompts = [];
    const unsubscribe = bridge.onUpdatePrompt((prompt) => prompts.push(prompt));

    ipcRenderer.emit('desktop-update:prompt', {}, { version: '0.12.0' });
    await bridge.updatePromptReady();

    assert.equal(prompts.length, 1);
    assert.equal(prompts[0].version, '0.12.0');
    assert.deepEqual(invoked, [
      ['desktop-update:register', undefined],
      ['desktop-update:ready', 'document-1'],
    ]);
    assert.deepEqual(sent, []);

    unsubscribe();
    ipcRenderer.emit('desktop-update:prompt', {}, { version: '0.13.0' });
    assert.equal(prompts.length, 1);
  });

  test('keeps the document token in preload and retries a rejected ready handshake once', async () => {
    const { bridge, sent, invoked } = loadBridge({
      readyResults: [{ accepted: false }, { accepted: true }],
    });

    await bridge.updatePromptReady();

    assert.deepEqual(invoked, [
      ['desktop-update:register', undefined],
      ['desktop-update:ready', 'document-1'],
      ['desktop-update:register', undefined],
      ['desktop-update:ready', 'document-2'],
    ]);
    assert.deepEqual(sent, [], 'the renderer-facing bridge must not expose a token-bearing send path');
  });

  test('stops after the single ready-handshake retry is rejected', async () => {
    const { bridge, invoked } = loadBridge({
      readyResults: [{ accepted: false }, { accepted: false }],
    });

    await bridge.updatePromptReady();

    assert.deepEqual(invoked, [
      ['desktop-update:register', undefined],
      ['desktop-update:ready', 'document-1'],
      ['desktop-update:register', undefined],
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
      ['desktop-update:register', undefined],
      ['desktop-update:settings:get', undefined],
      ['desktop-update:settings:set-auto-check', false],
    ]);
    assert.throws(() => bridge.setUpdateAutoCheck('false'), /invalid/i);
  });
});
