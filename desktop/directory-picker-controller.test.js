// #770 — directory picker IPC controller tests (no Electron runtime required)

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { describe, test } = require('node:test');

const { DirectoryPickerController, PICK_DIRECTORY_CHANNEL } = require('./directory-picker-controller');

function harness({ dialogResult = { canceled: false, filePaths: ['/Users/test/projects'] } } = {}) {
  const ipcMain = new EventEmitter();
  const handlers = new Map();
  ipcMain.handle = (channel, handler) => handlers.set(channel, handler);
  ipcMain.removeHandler = (channel) => handlers.delete(channel);
  const calls = [];
  const dialog = {
    showOpenDialog: async (options) => {
      calls.push(options);
      return dialogResult;
    },
  };
  const controller = new DirectoryPickerController({ ipcMain, dialog });
  return { controller, ipcMain, handlers, calls };
}

describe('DirectoryPickerController', () => {
  test('registers the pick-directory channel and returns the chosen absolute path', async () => {
    const h = harness();

    assert.equal(h.handlers.has(PICK_DIRECTORY_CHANNEL), true);
    const result = await h.handlers.get(PICK_DIRECTORY_CHANNEL)();
    assert.equal(result, '/Users/test/projects');
    assert.deepEqual(h.calls, [{ properties: ['openDirectory'] }]);
  });

  test('returns null when the dialog is cancelled', async () => {
    const h = harness({ dialogResult: { canceled: true, filePaths: [] } });

    assert.equal(await h.handlers.get(PICK_DIRECTORY_CHANNEL)(), null);
  });

  test('returns null when the dialog resolves no paths', async () => {
    const h = harness({ dialogResult: { canceled: false, filePaths: [] } });

    assert.equal(await h.handlers.get(PICK_DIRECTORY_CHANNEL)(), null);
  });

  test('dispose removes the registered handler', async () => {
    const h = harness();

    h.controller.dispose();
    assert.equal(h.handlers.has(PICK_DIRECTORY_CHANNEL), false);
  });
});
