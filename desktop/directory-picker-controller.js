// #770: main-process owner for the renderer directory picker IPC.

const PICK_DIRECTORY_CHANNEL = 'desktop:pick-directory';

class DirectoryPickerController {
  constructor({ ipcMain, dialog }) {
    this._ipcMain = ipcMain;
    this._dialog = dialog;
    this._onPickDirectory = this._handlePickDirectory.bind(this);
    ipcMain.handle(PICK_DIRECTORY_CHANNEL, this._onPickDirectory);
  }

  async _handlePickDirectory() {
    const result = await this._dialog.showOpenDialog({ properties: ['openDirectory'] });
    if (!result || result.canceled || !Array.isArray(result.filePaths) || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0];
  }

  dispose() {
    this._ipcMain.removeHandler(PICK_DIRECTORY_CHANNEL);
  }
}

module.exports = {
  DirectoryPickerController,
  PICK_DIRECTORY_CHANNEL,
};
