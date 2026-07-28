// F273 — context-isolated desktop update prompt transaction tests

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { describe, test } = require('node:test');

const {
  UpdatePromptController,
  UPDATE_PROMPT_CHANNEL,
  UPDATE_PROMPT_READY_CHANNEL,
  UPDATE_PROMPT_ACTION_CHANNEL,
} = require('./update-prompt-controller');

function harness(options = {}) {
  const ipcMain = new EventEmitter();
  const sent = [];
  const opened = [];
  const logs = [];
  const timers = [];
  const webContents = {
    send(channel, payload) {
      sent.push([channel, payload]);
    },
    isDestroyed: () => false,
  };
  webContents.mainFrame = {};
  const window = {
    webContents,
    isDestroyed: () => false,
    isMinimized: () => false,
    restore() {},
    show() {},
    focus() {},
  };
  const controller = new UpdatePromptController({
    ipcMain,
    getMainWindow: () => window,
    openExternal: async (url) => opened.push(url),
    dbg: (line) => logs.push(line),
    presentationTimeoutMs: 15_000,
    setTimeout: (callback, delay) => {
      const timer = { callback, delay, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (timer) => {
      timer.cleared = true;
    },
    ...options,
  });
  const event = { sender: webContents, senderFrame: webContents.mainFrame };
  const payload = {
    version: '0.12.0',
    currentVersion: '0.10.0',
    platform: 'windows',
    assetName: 'ClowderAI-Setup-0.12.0.exe',
    releaseUrl: 'https://github.com/zts212653/clowder-ai/releases/tag/v0.12.0',
  };
  return { controller, ipcMain, sent, opened, logs, timers, window, webContents, event, payload };
}

describe('UpdatePromptController', () => {
  test('rejects unsupported platforms and empty selected assets', async () => {
    const h = harness();

    await assert.rejects(() => h.controller.show({ ...h.payload, platform: 'linux' }), /Invalid update prompt payload/);
    await assert.rejects(() => h.controller.show({ ...h.payload, assetName: '' }), /Invalid update prompt payload/);
    assert.equal(h.timers.length, 0);
    h.controller.dispose();
  });

  test('resolves without an action when the renderer never becomes ready', async () => {
    const h = harness();
    const result = h.controller.show(h.payload);

    assert.equal(h.timers.length, 1);
    assert.equal(h.timers[0].delay, 15_000);
    h.timers[0].callback();

    assert.equal(await result, undefined);
    assert.ok(h.logs.some((line) => line.includes('did not become ready')));
    h.controller.dispose();
  });

  test('clears the presentation timeout when the trusted renderer becomes ready', async () => {
    const h = harness();
    const presentation = [];
    h.window.show = () => presentation.push('show');
    h.window.focus = () => presentation.push('focus');
    const result = h.controller.show(h.payload);
    const timer = h.timers[0];

    assert.deepEqual(presentation, [], 'do not expose the startup window before its renderer is ready');
    h.ipcMain.emit(UPDATE_PROMPT_READY_CHANNEL, h.event);

    assert.deepEqual(presentation, ['show', 'focus']);
    assert.equal(timer.cleared, true);
    timer.callback();
    h.ipcMain.emit(UPDATE_PROMPT_ACTION_CHANNEL, h.event, {
      version: h.payload.version,
      action: 'later',
    });
    assert.equal(await result, 'later');
    h.controller.dispose();
  });

  test('replays a pending prompt when the trusted renderer becomes ready', async () => {
    const h = harness();
    const result = h.controller.show(h.payload);

    h.ipcMain.emit(UPDATE_PROMPT_READY_CHANNEL, h.event);

    assert.deepEqual(h.sent.at(-1), [UPDATE_PROMPT_CHANNEL, h.payload]);
    h.ipcMain.emit(UPDATE_PROMPT_ACTION_CHANNEL, h.event, {
      version: h.payload.version,
      action: 'later',
    });
    assert.equal(await result, 'later');
    h.controller.dispose();
  });

  test('does not surface the startup window when renderer readiness has no pending prompt', () => {
    const h = harness();
    const presentation = [];
    h.window.show = () => presentation.push('show');
    h.window.focus = () => presentation.push('focus');

    h.ipcMain.emit(UPDATE_PROMPT_READY_CHANNEL, h.event);

    assert.deepEqual(presentation, []);
    h.controller.dispose();
  });

  test('surfaces and focuses a hidden main window before using a ready renderer', async () => {
    const h = harness();
    h.ipcMain.emit(UPDATE_PROMPT_READY_CHANNEL, h.event);
    const presentation = [];
    h.window.isMinimized = () => true;
    h.window.restore = () => presentation.push('restore');
    h.window.show = () => presentation.push('show');
    h.window.focus = () => presentation.push('focus');

    const result = h.controller.show(h.payload);

    assert.deepEqual(presentation, ['restore', 'show', 'focus']);
    assert.equal(h.timers.length, 0);
    h.ipcMain.emit(UPDATE_PROMPT_ACTION_CHANNEL, h.event, {
      version: h.payload.version,
      action: 'later',
    });
    assert.equal(await result, 'later');
    h.controller.dispose();
  });

  test('restores the presentation timeout after a ready renderer becomes unavailable', async () => {
    const h = harness();
    h.ipcMain.emit(UPDATE_PROMPT_READY_CHANNEL, h.event);

    h.controller.markRendererUnavailable();
    const result = h.controller.show(h.payload);

    assert.equal(h.timers.length, 1);
    h.timers[0].callback();
    assert.equal(await result, undefined);
    h.controller.dispose();
  });

  test('opens the main-owned release URL without resolving the prompt', async () => {
    const h = harness();
    let resolved = false;
    const result = h.controller.show(h.payload).then((action) => {
      resolved = true;
      return action;
    });

    h.ipcMain.emit(UPDATE_PROMPT_ACTION_CHANNEL, h.event, {
      version: h.payload.version,
      action: 'open-release',
    });
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(h.opened, [h.payload.releaseUrl]);
    assert.equal(resolved, false);

    h.ipcMain.emit(UPDATE_PROMPT_ACTION_CHANNEL, h.event, {
      version: h.payload.version,
      action: 'download',
    });
    assert.equal(await result, 'download');
    h.controller.dispose();
  });

  test('rejects other senders, child frames, stale versions, and unknown actions', async () => {
    const h = harness();
    let resolved = false;
    const result = h.controller.show(h.payload).then((action) => {
      resolved = true;
      return action;
    });
    const attacks = [
      [
        { sender: {}, senderFrame: {} },
        { version: '0.12.0', action: 'download' },
      ],
      [
        { sender: h.webContents, senderFrame: {} },
        { version: '0.12.0', action: 'download' },
      ],
      [h.event, { version: '9.9.9', action: 'download' }],
      [h.event, { version: '0.12.0', action: 'open-url', url: 'https://evil.example' }],
    ];

    for (const [event, action] of attacks) {
      h.ipcMain.emit(UPDATE_PROMPT_ACTION_CHANNEL, event, action);
    }
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(resolved, false);
    assert.deepEqual(h.opened, []);

    h.ipcMain.emit(UPDATE_PROMPT_ACTION_CHANNEL, h.event, {
      version: h.payload.version,
      action: 'skip',
    });
    assert.equal(await result, 'skip');
    assert.ok(h.logs.some((line) => line.includes('Rejected update prompt IPC')));
    h.controller.dispose();
  });

  test('resolves a prompt at most once and can safely show the next target', async () => {
    const h = harness();
    const first = h.controller.show(h.payload);
    h.ipcMain.emit(UPDATE_PROMPT_ACTION_CHANNEL, h.event, {
      version: h.payload.version,
      action: 'download',
    });
    h.ipcMain.emit(UPDATE_PROMPT_ACTION_CHANNEL, h.event, {
      version: h.payload.version,
      action: 'skip',
    });
    assert.equal(await first, 'download');

    const nextPayload = { ...h.payload, version: '0.13.0' };
    const second = h.controller.show(nextPayload);
    h.ipcMain.emit(UPDATE_PROMPT_ACTION_CHANNEL, h.event, {
      version: nextPayload.version,
      action: 'later',
    });
    assert.equal(await second, 'later');
    h.controller.dispose();
  });

  test('dispose resolves a pending prompt as later and removes IPC listeners', async () => {
    const h = harness();
    const result = h.controller.show(h.payload);

    h.controller.dispose();

    assert.equal(await result, 'later');
    assert.equal(h.ipcMain.listenerCount(UPDATE_PROMPT_READY_CHANNEL), 0);
    assert.equal(h.ipcMain.listenerCount(UPDATE_PROMPT_ACTION_CHANNEL), 0);
  });
});
