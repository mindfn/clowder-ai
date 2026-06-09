const assert = require('node:assert/strict');
const fs = require('node:fs');
const { existsSync, mkdirSync, rmSync, writeFileSync } = fs;
const { mkdtemp } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');

const moduleHome = path.join(tmpdir(), `service-manager-module-${process.pid}`);
mkdirSync(moduleHome, { recursive: true });
process.env.HOME = moduleHome;
process.env.LOCALAPPDATA = moduleHome;
process.env.USERPROFILE = moduleHome;

const ServiceManager = require('./service-manager');

after(() => {
  rmSync(moduleHome, { recursive: true, force: true });
});

function seedMirrorSource(root, name, probeFile = '.keep') {
  const dir = path.join(root, name);
  mkdirSync(path.dirname(path.join(dir, probeFile)), { recursive: true });
  writeFileSync(path.join(dir, probeFile), `${name}\n`, 'utf-8');
}

test('mirrors bundled plugins into the writable API project root', async () => {
  const installRoot = await mkdtemp(path.join(tmpdir(), 'service-manager-install-'));
  const userDataRoot = await mkdtemp(path.join(tmpdir(), 'service-manager-user-'));
  try {
    for (const name of ['.claude', 'assets', 'docs', 'guides', 'packages', 'scripts']) {
      seedMirrorSource(installRoot, name);
    }
    seedMirrorSource(installRoot, 'cat-cafe-skills', path.join('refs', 'shared-rules.md'));
    seedMirrorSource(installRoot, 'plugins', path.join('github', 'plugin.yaml'));

    const manager = new ServiceManager(installRoot, { frontendPort: 3003, apiPort: 3004 });

    manager._ensureUserDataDir(userDataRoot);

    assert.equal(existsSync(path.join(userDataRoot, 'project', 'plugins', 'github', 'plugin.yaml')), true);
  } finally {
    rmSync(installRoot, { recursive: true, force: true });
    rmSync(userDataRoot, { recursive: true, force: true });
  }
});

test('migrates existing project .cat-cafe into DATA_DIR before linking it back', async () => {
  const installRoot = await mkdtemp(path.join(tmpdir(), 'service-manager-install-'));
  const userDataRoot = await mkdtemp(path.join(tmpdir(), 'service-manager-user-'));
  try {
    const projectCatCafeDir = path.join(userDataRoot, 'project', '.cat-cafe');
    const stateDir = path.join(userDataRoot, 'data', 'cat-cafe');
    mkdirSync(projectCatCafeDir, { recursive: true });
    writeFileSync(path.join(projectCatCafeDir, 'cat-catalog.json'), '{"cats":[]}\n', 'utf-8');

    const manager = new ServiceManager(installRoot, { frontendPort: 3003, apiPort: 3004 });

    manager._ensureUserDataDir(userDataRoot);

    assert.equal(existsSync(path.join(stateDir, 'cat-catalog.json')), true);
    assert.equal(existsSync(path.join(projectCatCafeDir, 'cat-catalog.json')), true);
    assert.doesNotThrow(() => fs.readlinkSync(projectCatCafeDir));
    assert.equal(fs.realpathSync(projectCatCafeDir), fs.realpathSync(stateDir));
  } finally {
    rmSync(installRoot, { recursive: true, force: true });
    rmSync(userDataRoot, { recursive: true, force: true });
  }
});

test('migrates legacy desktop override data into DATA_DIR and CACHE_DIR', async () => {
  const installRoot = await mkdtemp(path.join(tmpdir(), 'service-manager-install-'));
  const userDataRoot = await mkdtemp(path.join(tmpdir(), 'service-manager-user-'));
  try {
    writeFileSync(path.join(userDataRoot, 'evidence.sqlite'), 'legacy-evidence', 'utf-8');
    writeFileSync(path.join(userDataRoot, 'evidence.sqlite-wal'), 'legacy-wal', 'utf-8');
    writeFileSync(path.join(userDataRoot, 'evidence.sqlite-shm'), 'legacy-shm', 'utf-8');
    writeFileSync(path.join(userDataRoot, 'evidence.sqlite-journal'), 'legacy-journal', 'utf-8');
    mkdirSync(path.join(userDataRoot, 'uploads'), { recursive: true });
    writeFileSync(path.join(userDataRoot, 'uploads', 'image.png'), 'legacy-upload', 'utf-8');
    mkdirSync(path.join(userDataRoot, 'data', 'connector-media'), { recursive: true });
    writeFileSync(path.join(userDataRoot, 'data', 'connector-media', 'media.bin'), 'legacy-media', 'utf-8');
    mkdirSync(path.join(userDataRoot, 'data', 'tts-cache'), { recursive: true });
    writeFileSync(path.join(userDataRoot, 'data', 'tts-cache', 'voice.wav'), 'legacy-tts', 'utf-8');

    const manager = new ServiceManager(installRoot, { frontendPort: 3003, apiPort: 3004 });

    manager._ensureUserDataDir(userDataRoot);

    assert.equal(existsSync(path.join(userDataRoot, 'data', 'evidence.sqlite')), true);
    assert.equal(existsSync(path.join(userDataRoot, 'data', 'evidence.sqlite-wal')), true);
    assert.equal(existsSync(path.join(userDataRoot, 'data', 'evidence.sqlite-shm')), true);
    assert.equal(existsSync(path.join(userDataRoot, 'data', 'evidence.sqlite-journal')), true);
    assert.equal(existsSync(path.join(userDataRoot, 'data', 'uploads', 'image.png')), true);
    assert.equal(existsSync(path.join(userDataRoot, 'cache', 'connector-media', 'media.bin')), true);
    assert.equal(existsSync(path.join(userDataRoot, 'cache', 'tts', 'voice.wav')), true);
    assert.equal(existsSync(path.join(userDataRoot, 'evidence.sqlite')), false);
    assert.equal(existsSync(path.join(userDataRoot, 'evidence.sqlite-wal')), false);
    assert.equal(existsSync(path.join(userDataRoot, 'evidence.sqlite-shm')), false);
    assert.equal(existsSync(path.join(userDataRoot, 'evidence.sqlite-journal')), false);
    assert.equal(existsSync(path.join(userDataRoot, 'uploads')), false);
    assert.equal(existsSync(path.join(userDataRoot, 'data', 'connector-media')), false);
    assert.equal(existsSync(path.join(userDataRoot, 'data', 'tts-cache')), false);
  } finally {
    rmSync(installRoot, { recursive: true, force: true });
    rmSync(userDataRoot, { recursive: true, force: true });
  }
});

test('probes bundled plugin mirror and rebuilds it when the first read fails', async () => {
  const installRoot = await mkdtemp(path.join(tmpdir(), 'service-manager-install-'));
  const userDataRoot = await mkdtemp(path.join(tmpdir(), 'service-manager-user-'));
  try {
    for (const name of ['.claude', 'assets', 'docs', 'guides', 'packages', 'scripts']) {
      seedMirrorSource(installRoot, name);
    }
    seedMirrorSource(installRoot, 'cat-cafe-skills', path.join('refs', 'shared-rules.md'));
    seedMirrorSource(installRoot, 'plugins', path.join('github', 'plugin.yaml'));

    const pluginProbePath = path.join(userDataRoot, 'project', 'plugins', 'github', 'plugin.yaml');
    const pluginMirrorPath = path.join(userDataRoot, 'project', 'plugins');
    const originalReadFileSync = fs.readFileSync;
    const originalSymlinkSync = fs.symlinkSync;
    let pluginProbeReads = 0;
    let pluginMirrorLinks = 0;
    fs.symlinkSync = function symlinkSyncWithProbeCount(src, dst, type) {
      if (dst === pluginMirrorPath) pluginMirrorLinks += 1;
      return originalSymlinkSync.call(this, src, dst, type);
    };
    fs.readFileSync = function readFileSyncWithOnePluginProbeFailure(filePath, ...args) {
      if (filePath === pluginProbePath) {
        pluginProbeReads += 1;
        if (pluginMirrorLinks < 2) {
          throw new Error('simulated unreadable plugin junction');
        }
      }
      return originalReadFileSync.call(this, filePath, ...args);
    };

    try {
      const manager = new ServiceManager(installRoot, { frontendPort: 3003, apiPort: 3004 });

      manager._ensureUserDataDir(userDataRoot);
    } finally {
      fs.readFileSync = originalReadFileSync;
      fs.symlinkSync = originalSymlinkSync;
    }

    assert.equal(pluginProbeReads, 2, 'plugin mirror should be probed, rebuilt, and verified');
    assert.equal(pluginMirrorLinks, 2, 'plugin mirror should be recreated after the failed probe');
    assert.equal(existsSync(pluginProbePath), true);
  } finally {
    rmSync(installRoot, { recursive: true, force: true });
    rmSync(userDataRoot, { recursive: true, force: true });
  }
});
