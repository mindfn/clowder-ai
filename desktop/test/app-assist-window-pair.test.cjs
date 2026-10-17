const assert = require('node:assert/strict');
const { resolve } = require('node:path');
const test = require('node:test');
const { createAppAssistHost } = require('../plugin-window/app-assist-host.cjs');
// Cross-writer staging is a test input only; production always uses its own fixed Host tree.
const windowRoot = process.env.F317_WINDOW_WRITER_ROOT || resolve(__dirname, '../..');
const { createManagedWindow } = require(resolve(windowRoot, 'desktop/plugin-window/window.cjs'));
const { fixture, input } = require(resolve(windowRoot, 'desktop/plugin-window/window-motion-fixture.cjs'));
const flush = () => new Promise((done) => setImmediate(done));

test('actual window with the actual app-assist Host stays stopped on show while locked and resumes after unlock', async () => {
  const f = fixture();
  let starts = 0;
  const host = createAppAssistHost({
    selfBundleIds: ['ai.fixture.self'],
    owner: { read: async () => ({ status: 'ready', keyScope: 'fixture-owner' }), claim: async () => 'claimed' },
    sourceFactory: async () => {
      starts++;
      return { close: async () => {} };
    },
  });
  const managed = await createManagedWindow(
    f.electron,
    { ...input, publicCompanionV2: true, companionContract: '0.1.0-beta.29' },
    {
      appAssist: host,
      validate: () => true,
      request: async () => ({ kind: 'state', phase: 'idle', behaviorEnabled: true }),
    },
  );
  try {
    assert.equal(host.snapshot().status, 'ready');
    assert.equal(starts, 1);
    f.electron.powerMonitor.emit('lock-screen');
    await flush();
    assert.equal(host.snapshot().status, 'suspended');
    f.win.emit('show');
    await flush();
    assert.equal(host.snapshot().status, 'suspended', 'a native show event must not override the lock suspension');
    assert.equal(starts, 1);
    f.electron.powerMonitor.emit('unlock-screen');
    await flush();
    assert.equal(host.snapshot().status, 'ready');
    assert.equal(starts, 2);
  } finally {
    managed.close();
    await host.close();
  }
});
