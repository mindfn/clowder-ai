import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

function baseShellEnv(overrides = {}) {
  return {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    TERM: process.env.TERM ?? 'xterm-256color',
    ...overrides,
  };
}

test('user-redis DATA_DIR migration moves legacy data into an empty target before status', () => {
  const scriptPath = resolve(process.cwd(), '../../scripts/user-redis.sh');
  const tempRoot = mkdtempSync(join(tmpdir(), 'cat-cafe-user-redis-data-dir-'));
  const tempHome = join(tempRoot, 'home');
  const dataRoot = join(tempRoot, 'runtime-data');
  const legacyDir = join(tempHome, '.cat-cafe', 'redis-user');
  const targetDir = join(dataRoot, 'redis');

  try {
    mkdirSync(legacyDir, { recursive: true });
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(legacyDir, 'dump.rdb'), 'legacy user redis', 'utf8');

    const result = spawnSync('bash', [scriptPath, 'status'], {
      encoding: 'utf8',
      env: baseShellEnv({
        HOME: tempHome,
        DATA_DIR: dataRoot,
      }),
    });

    assert.equal(result.status, 0, `status failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.equal(readFileSync(join(targetDir, 'dump.rdb'), 'utf8'), 'legacy user redis');
    assert.equal(existsSync(legacyDir), false);
    assert.match(result.stdout, new RegExp(`data dir: ${targetDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('user-redis DATA_DIR migration refuses populated target with legacy data present', () => {
  const scriptPath = resolve(process.cwd(), '../../scripts/user-redis.sh');
  const tempRoot = mkdtempSync(join(tmpdir(), 'cat-cafe-user-redis-populated-'));
  const tempHome = join(tempRoot, 'home');
  const dataRoot = join(tempRoot, 'runtime-data');
  const legacyDir = join(tempHome, '.cat-cafe', 'redis-user');
  const targetDir = join(dataRoot, 'redis');

  try {
    mkdirSync(legacyDir, { recursive: true });
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(legacyDir, 'dump.rdb'), 'legacy user redis', 'utf8');
    writeFileSync(join(targetDir, 'dump.rdb'), 'target user redis', 'utf8');

    const result = spawnSync('bash', [scriptPath, 'status'], {
      encoding: 'utf8',
      env: baseShellEnv({
        HOME: tempHome,
        DATA_DIR: dataRoot,
      }),
    });

    assert.notEqual(
      result.status,
      0,
      `status should fail closed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    assert.match(`${result.stdout}\n${result.stderr}`, /Refusing to switch user Redis data to DATA_DIR/);
    assert.equal(readFileSync(join(legacyDir, 'dump.rdb'), 'utf8'), 'legacy user redis');
    assert.equal(readFileSync(join(targetDir, 'dump.rdb'), 'utf8'), 'target user redis');
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('user-redis autobackup normalizes DATA_DIR before deriving local backup dir', () => {
  const scriptPath = resolve(process.cwd(), '../../scripts/user-redis-autobackup.sh');
  const tempRoot = mkdtempSync(join(tmpdir(), 'cat-cafe-user-redis-autobackup-'));
  const tempHome = join(tempRoot, 'home');
  const binDir = join(tempRoot, 'bin');
  const expectedBackupDir = join(realpathSync(tempRoot), 'runtime-data', 'redis-backups');

  try {
    mkdirSync(tempHome, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, 'launchctl'), '#!/usr/bin/env bash\nexit 1\n', 'utf8');
    writeFileSync(join(binDir, 'redis-cli'), '#!/usr/bin/env bash\nexit 1\n', 'utf8');
    chmodSync(join(binDir, 'launchctl'), 0o755);
    chmodSync(join(binDir, 'redis-cli'), 0o755);

    const result = spawnSync('bash', [scriptPath, 'status'], {
      cwd: tempRoot,
      encoding: 'utf8',
      env: baseShellEnv({
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        HOME: tempHome,
        DATA_DIR: './runtime-data',
      }),
    });

    assert.notEqual(result.status, 127, `status failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(result.stdout, new RegExp(`local:\\s+${expectedBackupDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
