// F273 — context-isolated desktop update prompt transaction tests

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { describe, test } = require('node:test');

const {
  UpdatePromptController,
  UPDATE_PROMPT_CHANNEL,
  UPDATE_DOCUMENT_CAPABILITY_CHANNEL,
  UPDATE_PROMPT_READY_CHANNEL,
  UPDATE_PROMPT_ACTION_CHANNEL,
  UPDATE_PROGRESS_CHANNEL,
  UPDATE_SETTINGS_GET_CHANNEL,
  UPDATE_SETTINGS_SET_AUTO_CHECK_CHANNEL,
} = require('./update-prompt-controller');

function harness(options = {}) {
  const ipcMain = new EventEmitter();
  const handlers = new Map();
  ipcMain.handle = (channel, handler) => handlers.set(channel, handler);
  ipcMain.removeHandler = (channel) => handlers.delete(channel);
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
  webContents.mainFrame = {
    url: 'http://localhost:3003/app?tab=updates#latest',
    send(channel, payload) {
      sent.push([channel, payload]);
    },
  };
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
    trustedOrigin: 'http://localhost:3003',
    getUpdateSettings: () => ({ autoCheck: true }),
    setUpdateAutoCheck: (enabled) => ({ autoCheck: enabled }),
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
  return { controller, ipcMain, handlers, sent, opened, logs, timers, window, webContents, event, payload };
}

function commitRendererDocument(h) {
  h.controller.markDocumentCommitted();
  h.controller.deliverDocumentCapability();
  const delivery = h.sent.findLast(([channel]) => channel === UPDATE_DOCUMENT_CAPABILITY_CHANNEL);
  assert.ok(delivery, 'trusted committed document must receive a main-owned capability');
  return delivery[1];
}

function readyRenderer(h, documentToken, event = h.event) {
  return h.handlers.get(UPDATE_PROMPT_READY_CHANNEL)(event, documentToken);
}

function makeRendererReady(h, event = h.event) {
  const documentToken = commitRendererDocument(h);
  assert.deepEqual(readyRenderer(h, documentToken, event), { accepted: true });
  return documentToken;
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
    makeRendererReady(h);

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

    makeRendererReady(h);

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

    makeRendererReady(h);

    assert.deepEqual(presentation, []);
    h.controller.dispose();
  });

  test('notifies the schedule owner only after trusted renderer readiness and once per readiness epoch', () => {
    const readyEpochs = [];
    const h = harness({ onRendererReady: () => readyEpochs.push('ready') });

    assert.deepEqual(readyEpochs, []);
    assert.deepEqual(readyRenderer(h, 'forged', { sender: {}, senderFrame: {} }), { accepted: false });
    assert.deepEqual(readyEpochs, [], 'untrusted renderer must not start the automatic schedule');

    const firstToken = makeRendererReady(h);
    assert.deepEqual(readyRenderer(h, firstToken), { accepted: true });
    assert.deepEqual(readyEpochs, ['ready'], 'duplicate ready events in one document must be idempotent');

    h.controller.markRendererUnavailable();
    assert.deepEqual(readyRenderer(h, firstToken), { accepted: false }, 'commit must revoke the old document token');
    makeRendererReady(h);
    assert.deepEqual(readyEpochs, ['ready', 'ready'], 'a new trusted document creates a new readiness epoch');
    h.controller.dispose();
  });

  test('replaces document authority only on commit and accepts ready only for the current main-owned token', () => {
    const h = harness();
    const firstToken = commitRendererDocument(h);

    assert.equal(typeof firstToken, 'string');
    assert.deepEqual(readyRenderer(h, undefined), { accepted: false });
    assert.deepEqual(readyRenderer(h, { token: firstToken }), { accepted: false });
    assert.deepEqual(readyRenderer(h, firstToken), { accepted: true });

    const secondToken = commitRendererDocument(h);
    assert.notEqual(secondToken, firstToken);
    assert.deepEqual(readyRenderer(h, firstToken), { accepted: false });
    assert.deepEqual(readyRenderer(h, secondToken), { accepted: true });
    assert.equal(h.handlers.has('desktop-update:register'), false, 'renderer IPC cannot replace document authority');
    h.controller.dispose();
  });

  test('does not let a retired document registration replace an already-ready document', async () => {
    const readyEpochs = [];
    const h = harness({ onRendererReady: () => readyEpochs.push('ready') });
    const currentToken = makeRendererReady(h);

    const retiredRegister = h.handlers.get('desktop-update:register');
    retiredRegister?.(h.event);
    assert.equal(retiredRegister, undefined, 'renderer-initiated registration must not exist');

    assert.deepEqual(
      readyRenderer(h, currentToken),
      { accepted: true },
      'a retired document message must not replace the commit-owned capability',
    );
    assert.deepEqual(readyEpochs, ['ready'], 'the live document must remain in its existing readiness epoch');

    const result = h.controller.show(h.payload);
    assert.equal(h.timers.length, 0, 'the live ready document must not regress to a native-fallback timer');
    h.ipcMain.emit(UPDATE_PROMPT_ACTION_CHANNEL, h.event, {
      version: h.payload.version,
      action: 'later',
    });
    assert.equal(await result, 'later');
    h.controller.dispose();
  });

  test('rejects a queued ready from the old document after main-document commit', async () => {
    const readyEpochs = [];
    const h = harness({ onRendererReady: () => readyEpochs.push('ready') });

    const oldToken = makeRendererReady(h);
    h.controller.markRendererUnavailable();
    assert.deepEqual(readyRenderer(h, oldToken), { accepted: false });

    const result = h.controller.show(h.payload);
    assert.deepEqual(readyEpochs, ['ready'], 'the retired document must not start a new readiness epoch');
    assert.equal(h.timers.length, 1, 'a stale ready must not suppress the bounded presentation fallback');
    assert.equal(h.timers[0].cleared, false);

    h.timers[0].callback();
    assert.equal(await result, undefined);
    h.controller.dispose();
  });

  test('re-arms only one pending presentation timer across repeated commit and crash invalidation', async () => {
    const h = harness();
    const oldToken = makeRendererReady(h);
    const result = h.controller.show(h.payload);

    assert.equal(h.timers.length, 0);
    h.controller.markRendererUnavailable();
    h.controller.markRendererUnavailable();
    assert.equal(h.timers.length, 1);
    assert.deepEqual(readyRenderer(h, oldToken), { accepted: false });

    makeRendererReady(h);
    assert.equal(h.timers[0].cleared, true);
    h.ipcMain.emit(UPDATE_PROMPT_ACTION_CHANNEL, h.event, {
      version: h.payload.version,
      action: 'later',
    });
    assert.equal(await result, 'later');
    h.controller.dispose();
  });

  test('stores active download progress and replays it after a renderer reload', () => {
    const h = harness();
    const progress = {
      phase: 'downloading',
      version: '0.12.0',
      assetName: 'ClowderAI-Setup-0.12.0.exe',
      progress: 0.42,
    };

    h.controller.setProgress(progress);
    assert.deepEqual(h.sent, [], 'do not send status before a trusted renderer is ready');

    makeRendererReady(h);
    assert.deepEqual(h.sent.at(-1), [UPDATE_PROGRESS_CHANNEL, progress]);

    h.controller.markRendererUnavailable();
    h.controller.setProgress({ ...progress, progress: 0.67 });
    makeRendererReady(h);
    assert.deepEqual(h.sent.at(-1), [UPDATE_PROGRESS_CHANNEL, { ...progress, progress: 0.67 }]);

    h.controller.setProgress(null);
    assert.deepEqual(h.sent.at(-1), [UPDATE_PROGRESS_CHANNEL, null]);
    h.controller.dispose();
  });

  test('rejects malformed main-owned download progress snapshots', () => {
    const h = harness();

    assert.throws(() => h.controller.setProgress({ phase: 'downloading', progress: Number.NaN }), /progress/i);
    assert.throws(
      () => h.controller.setProgress({ phase: 'downloading', version: '0.12.0', assetName: '', progress: 2 }),
      /progress/i,
    );
    h.controller.dispose();
  });

  test('serves automatic-update preferences only to the trusted main frame', async () => {
    const writes = [];
    const h = harness({
      getUpdateSettings: () => ({ autoCheck: false }),
      setUpdateAutoCheck: (enabled) => {
        writes.push(enabled);
        return { autoCheck: enabled };
      },
    });
    const getSettings = h.handlers.get(UPDATE_SETTINGS_GET_CHANNEL);
    const setAutoCheck = h.handlers.get(UPDATE_SETTINGS_SET_AUTO_CHECK_CHANNEL);

    assert.equal(typeof getSettings, 'function');
    assert.equal(typeof setAutoCheck, 'function');
    assert.deepEqual(await getSettings(h.event), { autoCheck: false });
    assert.deepEqual(await setAutoCheck(h.event, true), { autoCheck: true });
    assert.deepEqual(writes, [true]);

    await assert.rejects(() => getSettings({ sender: {}, senderFrame: {} }), /untrusted/i);
    await assert.rejects(() => setAutoCheck(h.event, 'false'), /boolean/i);
    h.controller.dispose();
  });

  test('surfaces and focuses a hidden main window before using a ready renderer', async () => {
    const h = harness();
    makeRendererReady(h);
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
    makeRendererReady(h);

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

  test('rejects prompt replay and actions from an unexpected main-frame origin', async () => {
    const h = harness();
    h.webContents.mainFrame.url = 'http://localhost:3003@attacker.example/update';
    let resolved = false;
    const result = h.controller.show(h.payload).then((action) => {
      resolved = true;
      return action;
    });

    assert.deepEqual(readyRenderer(h, 'forged'), { accepted: false });
    h.ipcMain.emit(UPDATE_PROMPT_ACTION_CHANNEL, h.event, {
      version: h.payload.version,
      action: 'download',
    });
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(h.sent, [], 'do not expose prompt payloads to an unexpected origin');
    assert.equal(h.timers.length, 1, 'keep the bounded native fallback active');
    assert.equal(h.timers[0].cleared, false);
    assert.equal(resolved, false);

    h.timers[0].callback();
    assert.equal(await result, undefined);
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
    makeRendererReady(h);
    const result = h.controller.show(h.payload);

    h.controller.dispose();
    const sentAtDispose = h.sent.length;
    h.controller.deliverDocumentCapability();

    assert.equal(await result, 'later');
    assert.equal(h.sent.length, sentAtDispose, 'disposed readiness authority must not be deliverable');
    assert.equal(h.ipcMain.listenerCount(UPDATE_PROMPT_READY_CHANNEL), 0);
    assert.equal(h.ipcMain.listenerCount(UPDATE_PROMPT_ACTION_CHANNEL), 0);
    assert.equal(h.handlers.has('desktop-update:register'), false);
    assert.equal(h.handlers.has(UPDATE_PROMPT_READY_CHANNEL), false);
    assert.equal(h.handlers.has(UPDATE_SETTINGS_GET_CHANNEL), false);
    assert.equal(h.handlers.has(UPDATE_SETTINGS_SET_AUTO_CHECK_CHANNEL), false);
  });
});
