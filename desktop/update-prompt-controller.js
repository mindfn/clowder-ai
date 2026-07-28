// F273: main-process owner for one context-isolated update-prompt transaction.

const { randomUUID } = require('node:crypto');
const { safeErrorMessage } = require('./update-network-diagnostics');

const UPDATE_PROMPT_CHANNEL = 'desktop-update:prompt';
const UPDATE_DOCUMENT_CAPABILITY_CHANNEL = 'desktop-update:document-capability';
const UPDATE_PROMPT_READY_CHANNEL = 'desktop-update:ready';
const UPDATE_PROMPT_ACTION_CHANNEL = 'desktop-update:action';
const UPDATE_PROGRESS_CHANNEL = 'desktop-update:progress';
const UPDATE_SETTINGS_GET_CHANNEL = 'desktop-update:settings:get';
const UPDATE_SETTINGS_SET_AUTO_CHECK_CHANNEL = 'desktop-update:settings:set-auto-check';
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

function isProgressPayload(payload) {
  return (
    payload &&
    payload.phase === 'downloading' &&
    typeof payload.version === 'string' &&
    payload.version.length > 0 &&
    typeof payload.assetName === 'string' &&
    payload.assetName.length > 0 &&
    Number.isFinite(payload.progress) &&
    payload.progress >= 0 &&
    payload.progress <= 1
  );
}

class UpdatePromptController {
  constructor({
    ipcMain,
    getMainWindow,
    openExternal,
    dbg,
    trustedOrigin,
    getUpdateSettings,
    setUpdateAutoCheck,
    onRendererReady = () => {},
    presentationTimeoutMs = 15_000,
    setTimeout: scheduleTimeout = setTimeout,
    clearTimeout: cancelTimeout = clearTimeout,
  }) {
    this._ipcMain = ipcMain;
    this._getMainWindow = getMainWindow;
    this._openExternal = openExternal;
    this._dbg = dbg;
    this._trustedOrigin = trustedOrigin;
    this._getUpdateSettings = getUpdateSettings;
    this._setUpdateAutoCheck = setUpdateAutoCheck;
    this._onRendererReady = onRendererReady;
    this._presentationTimeoutMs = presentationTimeoutMs;
    this._setTimeout = scheduleTimeout;
    this._clearTimeout = cancelTimeout;
    this._documentToken = null;
    this._rendererReady = false;
    this._pending = null;
    this._progress = null;
    this._hasProgressSnapshot = false;
    this._onReady = this._handleReady.bind(this);
    this._onAction = this._handleAction.bind(this);
    this._onGetSettings = this._handleGetSettings.bind(this);
    this._onSetAutoCheck = this._handleSetAutoCheck.bind(this);
    ipcMain.handle(UPDATE_PROMPT_READY_CHANNEL, this._onReady);
    ipcMain.on(UPDATE_PROMPT_ACTION_CHANNEL, this._onAction);
    ipcMain.handle(UPDATE_SETTINGS_GET_CHANNEL, this._onGetSettings);
    ipcMain.handle(UPDATE_SETTINGS_SET_AUTO_CHECK_CHANNEL, this._onSetAutoCheck);
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
    this._documentToken = null;
    this._rendererReady = false;
    if (!this._pending) return;
    this._pending.presentationReady = false;
    this._startPresentationTimer(this._pending);
  }

  markDocumentCommitted() {
    this.markRendererUnavailable();
    if (!isTrustedWindow(this._getMainWindow(), this._trustedOrigin)) return;
    this._documentToken = randomUUID();
  }

  deliverDocumentCapability() {
    const window = this._getMainWindow();
    if (!this._documentToken || !isTrustedWindow(window, this._trustedOrigin)) return;
    window.webContents.mainFrame.send(UPDATE_DOCUMENT_CAPABILITY_CHANNEL, this._documentToken);
  }

  _handleReady(event, documentToken) {
    if (!isTrustedSender(event, this._getMainWindow(), this._trustedOrigin)) {
      this._dbg('Rejected update prompt IPC: untrusted ready sender');
      return { accepted: false };
    }
    if (typeof documentToken !== 'string' || !this._documentToken || documentToken !== this._documentToken) {
      this._dbg('Rejected update prompt IPC: stale renderer document');
      return { accepted: false };
    }
    const beginsReadinessEpoch = !this._rendererReady;
    this._rendererReady = true;
    if (beginsReadinessEpoch) {
      try {
        this._onRendererReady();
      } catch (error) {
        this._dbg(`Update renderer readiness callback failed: ${safeErrorMessage(error)}`);
      }
    }
    if (this._pending) {
      const presentationReady = this._presentMainWindow();
      this._pending.presentationReady = presentationReady;
      if (presentationReady) this._clearPresentationTimer(this._pending);
    }
    this._sendPending();
    this._sendProgress();
    return { accepted: true };
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

  async _handleGetSettings(event) {
    if (!isTrustedSender(event, this._getMainWindow(), this._trustedOrigin)) {
      throw new Error('Untrusted desktop update settings sender');
    }
    const settings = await this._getUpdateSettings();
    if (!settings || typeof settings.autoCheck !== 'boolean') {
      throw new TypeError('Invalid desktop update settings');
    }
    return { autoCheck: settings.autoCheck };
  }

  async _handleSetAutoCheck(event, enabled) {
    if (!isTrustedSender(event, this._getMainWindow(), this._trustedOrigin)) {
      throw new Error('Untrusted desktop update settings sender');
    }
    if (typeof enabled !== 'boolean') throw new TypeError('autoCheck must be a boolean');
    const settings = await this._setUpdateAutoCheck(enabled);
    if (!settings || typeof settings.autoCheck !== 'boolean') {
      throw new TypeError('Invalid desktop update settings');
    }
    return { autoCheck: settings.autoCheck };
  }

  _sendPending() {
    const window = this._getMainWindow();
    if (!this._pending) return;
    if (!isTrustedWindow(window, this._trustedOrigin)) return;
    window.webContents.send(UPDATE_PROMPT_CHANNEL, this._pending.payload);
  }

  setProgress(progress) {
    if (progress !== null && !isProgressPayload(progress)) {
      throw new TypeError('Invalid desktop update progress');
    }
    this._progress = progress === null ? null : Object.freeze({ ...progress });
    this._hasProgressSnapshot = true;
    this._sendProgress();
  }

  _sendProgress() {
    const window = this._getMainWindow();
    if (!this._rendererReady || !this._hasProgressSnapshot) return;
    if (!isTrustedWindow(window, this._trustedOrigin)) return;
    window.webContents.send(UPDATE_PROGRESS_CHANNEL, this._progress);
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
    this._documentToken = null;
    this._rendererReady = false;
    this._ipcMain.removeListener(UPDATE_PROMPT_ACTION_CHANNEL, this._onAction);
    this._ipcMain.removeHandler(UPDATE_PROMPT_READY_CHANNEL);
    this._ipcMain.removeHandler(UPDATE_SETTINGS_GET_CHANNEL);
    this._ipcMain.removeHandler(UPDATE_SETTINGS_SET_AUTO_CHECK_CHANNEL);
    if (this._pending) {
      this._finishPending(this._pending, 'later');
    }
  }
}

module.exports = {
  isExpectedOrigin,
  UpdatePromptController,
  UPDATE_PROMPT_CHANNEL,
  UPDATE_DOCUMENT_CAPABILITY_CHANNEL,
  UPDATE_PROMPT_READY_CHANNEL,
  UPDATE_PROMPT_ACTION_CHANNEL,
  UPDATE_PROGRESS_CHANNEL,
  UPDATE_SETTINGS_GET_CHANNEL,
  UPDATE_SETTINGS_SET_AUTO_CHECK_CHANNEL,
};
