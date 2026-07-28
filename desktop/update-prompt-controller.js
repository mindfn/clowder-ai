// F273: main-process owner for one context-isolated update-prompt transaction.

const { safeErrorMessage } = require('./update-network-diagnostics');

const UPDATE_PROMPT_CHANNEL = 'desktop-update:prompt';
const UPDATE_PROMPT_READY_CHANNEL = 'desktop-update:ready';
const UPDATE_PROMPT_ACTION_CHANNEL = 'desktop-update:action';
const TERMINAL_ACTIONS = new Set(['download', 'later', 'skip']);
const ALL_ACTIONS = new Set([...TERMINAL_ACTIONS, 'open-release']);
const PROMPT_PLATFORMS = new Set(['windows', 'macos']);

function isExpectedOrigin(url, expectedOrigin) {
  if (typeof url !== 'string') return false;
  if (typeof expectedOrigin !== 'string') return false;
  try {
    return new URL(url).origin === expectedOrigin;
  } catch {
    return false;
  }
}

function isTrustedWindow(window, trustedOrigin) {
  return (
    window &&
    !window.isDestroyed?.() &&
    !window.webContents?.isDestroyed?.() &&
    isExpectedOrigin(window.webContents?.mainFrame?.url, trustedOrigin)
  );
}

function isTrustedSender(event, window, trustedOrigin) {
  if (!isTrustedWindow(window, trustedOrigin)) return false;
  if (event?.sender !== window.webContents) return false;
  return Boolean(event.senderFrame && event.senderFrame === event.sender.mainFrame);
}

function isPromptPayload(payload) {
  return (
    payload &&
    typeof payload.version === 'string' &&
    typeof payload.currentVersion === 'string' &&
    PROMPT_PLATFORMS.has(payload.platform) &&
    typeof payload.assetName === 'string' &&
    payload.assetName.length > 0 &&
    typeof payload.releaseUrl === 'string'
  );
}

class UpdatePromptController {
  constructor({
    ipcMain,
    getMainWindow,
    openExternal,
    dbg,
    trustedOrigin,
    presentationTimeoutMs = 15_000,
    setTimeout: scheduleTimeout = setTimeout,
    clearTimeout: cancelTimeout = clearTimeout,
  }) {
    this._ipcMain = ipcMain;
    this._getMainWindow = getMainWindow;
    this._openExternal = openExternal;
    this._dbg = dbg;
    this._trustedOrigin = trustedOrigin;
    this._presentationTimeoutMs = presentationTimeoutMs;
    this._setTimeout = scheduleTimeout;
    this._clearTimeout = cancelTimeout;
    this._rendererReady = false;
    this._pending = null;
    this._onReady = this._handleReady.bind(this);
    this._onAction = this._handleAction.bind(this);
    ipcMain.on(UPDATE_PROMPT_READY_CHANNEL, this._onReady);
    ipcMain.on(UPDATE_PROMPT_ACTION_CHANNEL, this._onAction);
  }

  show(payload) {
    if (!isPromptPayload(payload)) return Promise.reject(new TypeError('Invalid update prompt payload'));
    if (this._pending) {
      this._dbg(`Update prompt already pending for v${this._pending.payload.version}`);
      return this._pending.promise;
    }

    const presentationReady = this._rendererReady && this._presentMainWindow();
    let resolve;
    const promise = new Promise((done) => {
      resolve = done;
    });
    const pending = {
      payload: Object.freeze({ ...payload }),
      promise,
      resolve,
      presentationReady,
      presentationTimer: null,
    };
    this._pending = pending;
    if (!pending.presentationReady) this._startPresentationTimer(pending);
    this._sendPending();
    return promise;
  }

  _presentMainWindow() {
    const window = this._getMainWindow();
    if (!isTrustedWindow(window, this._trustedOrigin)) return false;
    if (window.isMinimized?.()) window.restore();
    window.show?.();
    window.focus?.();
    return true;
  }

  markRendererUnavailable() {
    this._rendererReady = false;
    if (!this._pending) return;
    this._pending.presentationReady = false;
    this._startPresentationTimer(this._pending);
  }

  _handleReady(event) {
    if (!isTrustedSender(event, this._getMainWindow(), this._trustedOrigin)) {
      this._dbg('Rejected update prompt IPC: untrusted ready sender');
      return;
    }
    this._rendererReady = true;
    if (this._pending) {
      const presentationReady = this._presentMainWindow();
      this._pending.presentationReady = presentationReady;
      if (presentationReady) this._clearPresentationTimer(this._pending);
    }
    this._sendPending();
  }

  _handleAction(event, message) {
    const window = this._getMainWindow();
    const pending = this._pending;
    if (
      !pending ||
      !isTrustedSender(event, window, this._trustedOrigin) ||
      !message ||
      message.version !== pending.payload.version ||
      !ALL_ACTIONS.has(message.action)
    ) {
      this._dbg('Rejected update prompt IPC: sender, version, or action mismatch');
      return;
    }

    if (message.action === 'open-release') {
      void Promise.resolve(this._openExternal(pending.payload.releaseUrl)).catch((error) => {
        this._dbg(`Could not open update release page: ${safeErrorMessage(error)}`);
      });
      return;
    }

    this._finishPending(pending, message.action);
  }

  _sendPending() {
    const window = this._getMainWindow();
    if (!this._pending) return;
    if (!isTrustedWindow(window, this._trustedOrigin)) return;
    window.webContents.send(UPDATE_PROMPT_CHANNEL, this._pending.payload);
  }

  _startPresentationTimer(pending) {
    if (pending.presentationTimer) return;
    pending.presentationTimer = this._setTimeout(() => {
      if (this._pending !== pending || pending.presentationReady) return;
      this._dbg(`Rendered update prompt did not become ready for v${pending.payload.version}`);
      this._finishPending(pending, undefined);
    }, this._presentationTimeoutMs);
  }

  _clearPresentationTimer(pending) {
    if (!pending.presentationTimer) return;
    this._clearTimeout(pending.presentationTimer);
    pending.presentationTimer = null;
  }

  _finishPending(pending, action) {
    if (this._pending !== pending) return;
    this._pending = null;
    this._clearPresentationTimer(pending);
    pending.resolve(action);
  }

  dispose() {
    this._ipcMain.removeListener(UPDATE_PROMPT_READY_CHANNEL, this._onReady);
    this._ipcMain.removeListener(UPDATE_PROMPT_ACTION_CHANNEL, this._onAction);
    if (this._pending) {
      this._finishPending(this._pending, 'later');
    }
  }
}

module.exports = {
  isExpectedOrigin,
  UpdatePromptController,
  UPDATE_PROMPT_CHANNEL,
  UPDATE_PROMPT_READY_CHANNEL,
  UPDATE_PROMPT_ACTION_CHANNEL,
};
