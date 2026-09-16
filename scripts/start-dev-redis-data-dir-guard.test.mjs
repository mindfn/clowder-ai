import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const hasRedis =
  spawnSync('bash', ['-lc', 'command -v redis-server >/dev/null && command -v redis-cli >/dev/null'], {
    encoding: 'utf8',
  }).status === 0;

// Effect tests below start real redis-server processes on free localhost ports
// with throwaway data dirs under the OS temp directory. The machine's real
// instances (e.g. the running 6099 service) are only observed read-only via
// `ps`/`CONFIG GET dir`, never written to or shut down.
const describeRedis = hasRedis ? describe : describe.skip;

function createSandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'cc-redis-dir-guard-'));
  mkdirSync(join(dir, 'scripts', 'lib'), { recursive: true });
  cpSync(resolve(ROOT, 'scripts/start-dev.sh'), join(dir, 'scripts', 'start-dev.sh'));
  for (const lib of ['node-runtime-guard.sh', 'redis-rdb-first.sh', 'download-source-overrides.sh']) {
    const source = resolve(ROOT, 'scripts/lib', lib);
    if (lib === 'download-source-overrides.sh') {
      const topLevel = resolve(ROOT, 'scripts', lib);
      if (existsSync(topLevel)) cpSync(topLevel, join(dir, 'scripts', lib));
      continue;
    }
    cpSync(source, join(dir, 'scripts', 'lib', lib));
  }
  return dir;
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

function redisCli(port, ...args) {
  return spawnSync('redis-cli', ['-p', String(port), ...args], { encoding: 'utf8' });
}

function waitForPong(port, attempts = 50) {
  for (let i = 0; i < attempts; i += 1) {
    const result = redisCli(port, 'ping');
    if (result.status === 0 && result.stdout.trim() === 'PONG') return true;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  return false;
}

function startHelperRedis(port, dir) {
  const result = spawnSync(
    'redis-server',
    [
      '--port',
      String(port),
      '--bind',
      '127.0.0.1',
      '--dir',
      dir,
      '--daemonize',
      'yes',
      '--save',
      '',
      '--appendonly',
      'no',
      '--pidfile',
      join(dir, 'helper-redis.pid'),
      '--logfile',
      join(dir, 'helper-redis.log'),
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, `helper redis should start: ${result.stderr}`);
  assert.ok(waitForPong(port), `helper redis should answer on port ${port}`);
  const pid = readFileSync(join(dir, 'helper-redis.pid'), 'utf8').trim();
  return { port, pid };
}

function stopHelperRedis(port) {
  redisCli(port, 'shutdown', 'nosave');
}

function runSourceOnly({ sandboxDir, env, commands }) {
  const command = commands.join('; ');
  return spawnSync('bash', ['-lc', command], {
    cwd: sandboxDir,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      TERM: process.env.TERM ?? 'xterm-256color',
      ...env,
    },
    encoding: 'utf8',
  });
}

describeRedis('start-dev redis data dir guard', () => {
  let sandboxDir;
  let baseDir;
  let helper;

  before(async () => {
    sandboxDir = createSandbox();
    baseDir = mkdtempSync(join(tmpdir(), 'cc-redis-dir-guard-data-'));
    const helperPort = await freePort();
    mkdirSync(join(baseDir, 'shared'), { recursive: true });
    helper = startHelperRedis(helperPort, join(baseDir, 'shared'));
  });

  after(() => {
    if (helper) stopHelperRedis(helper.port);
    for (const dir of [sandboxDir, baseDir]) {
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  it('detects the live redis already using the target data dir and reports its port and pid', async () => {
    const otherPort = await freePort();
    const result = runSourceOnly({
      sandboxDir,
      env: { REDIS_PORT: String(otherPort), REDIS_DATA_DIR: join(baseDir, 'shared') },
      commands: [
        'source scripts/start-dev.sh --source-only',
        'if conflict=$(find_redis_using_data_dir "$REDIS_DATA_DIR"); then rc=0; else rc=1; fi',
        'printf "RC=%s\\nCONFLICT=%s\\n" "$rc" "$conflict"',
      ],
    });
    assert.equal(result.status, 0, `source-only probe should succeed: ${result.stderr}`);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.match(output, /RC=0/, `conflict should be detected: ${output}`);
    assert.ok(output.includes(String(helper.port)), `output should name the conflicting port: ${output}`);
    assert.ok(output.includes(helper.pid), `output should name the conflicting pid: ${output}`);
  });

  it('reports no conflict when the target data dir is not used by any live redis', async () => {
    mkdirSync(join(baseDir, 'free'), { recursive: true });
    const otherPort = await freePort();
    const result = runSourceOnly({
      sandboxDir,
      env: { REDIS_PORT: String(otherPort), REDIS_DATA_DIR: join(baseDir, 'free') },
      commands: [
        'source scripts/start-dev.sh --source-only',
        'if conflict=$(find_redis_using_data_dir "$REDIS_DATA_DIR"); then rc=0; else rc=1; fi',
        'printf "RC=%s\\nCONFLICT=%s\\n" "$rc" "$conflict"',
      ],
    });
    assert.equal(result.status, 0, `source-only probe should succeed: ${result.stderr}`);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.match(output, /RC=1/, `free dir should not conflict: ${output}`);
    assert.match(output, /CONFLICT=\s*$/m, `conflict output should be empty: ${output}`);
  });

  it('setup_storage refuses to start a second redis on a shared data dir, naming the conflicting port and pid', async () => {
    const otherPort = await freePort();
    const result = runSourceOnly({
      sandboxDir,
      env: {
        REDIS_PORT: String(otherPort),
        REDIS_DATA_DIR: join(baseDir, 'shared'),
        REDIS_BACKUP_DIR: join(baseDir, 'backups-conflict'),
      },
      commands: ['source scripts/start-dev.sh --source-only', 'setup_storage'],
    });
    const output = `${result.stdout}\n${result.stderr}`;
    assert.notEqual(result.status, 0, `setup_storage should refuse on a shared data dir: ${output}`);
    assert.ok(output.includes('占用'), `refusal should explain the dir is occupied: ${output}`);
    assert.ok(output.includes(String(helper.port)), `refusal should name the conflicting port: ${output}`);
    assert.ok(output.includes(helper.pid), `refusal should name the conflicting pid: ${output}`);
    const probe = redisCli(otherPort, 'ping');
    assert.notEqual(probe.stdout.trim(), 'PONG', 'no second redis should have been started');
  });

  it('setup_storage starts normally when the data dir is free and leaves other instances alone', async () => {
    mkdirSync(join(baseDir, 'fresh'), { recursive: true });
    const otherPort = await freePort();
    const result = runSourceOnly({
      sandboxDir,
      env: {
        REDIS_PORT: String(otherPort),
        REDIS_DATA_DIR: join(baseDir, 'fresh'),
        REDIS_BACKUP_DIR: join(baseDir, 'backups-fresh'),
      },
      commands: ['source scripts/start-dev.sh --source-only', 'setup_storage'],
    });
    const output = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.status, 0, `setup_storage should start on a free data dir: ${output}`);
    assert.ok(output.includes('Redis 已启动'), `expected startup banner: ${output}`);
    // The EXIT trap shuts the just-started redis down; the pre-existing helper
    // instance on the shared dir must survive untouched.
    assert.ok(waitForPong(helper.port, 10), 'helper redis on the shared dir should still be alive');
    const probe = redisCli(otherPort, 'ping');
    assert.notEqual(probe.stdout.trim(), 'PONG', 'started redis should have been shut down by cleanup');
  });
});
