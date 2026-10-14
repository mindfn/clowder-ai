import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const withTestHome = resolve(__dirname, '../scripts/with-test-home.sh');

test('with-test-home isolates installer writes from inherited account roots and legacy HOME', () => {
  const outerRoot = mkdtempSync(join(tmpdir(), 'account-root-sentinel-'));
  const configDir = join(outerRoot, '.cat-cafe');
  const outerHome = join(outerRoot, 'home');
  mkdirSync(configDir);
  mkdirSync(join(outerHome, '.cat-cafe'), { recursive: true });
  const sentinels = {
    'accounts.json': JSON.stringify({ 'user-owned': { authType: 'api_key', displayName: 'Keep me' } }),
    'credentials.json': JSON.stringify({ 'user-owned': { apiKey: 'sentinel-only' } }),
    'cat-catalog.json': JSON.stringify({ accounts: {}, breeds: [{ accountRef: 'user-owned' }] }),
    'provider-profiles.json': JSON.stringify({
      version: 2,
      providers: [{ id: 'installer-managed', authType: 'api_key', displayName: 'Outer legacy' }],
    }),
    'provider-profiles.secrets.local.json': JSON.stringify({
      profiles: { 'installer-managed': { apiKey: 'legacy-sentinel' } },
    }),
  };
  try {
    for (const [name, content] of Object.entries(sentinels)) writeFileSync(join(configDir, name), content);
    for (const name of ['provider-profiles.json', 'provider-profiles.secrets.local.json']) {
      writeFileSync(join(outerHome, '.cat-cafe', name), sentinels[name]);
    }
    const installer = resolve(__dirname, '../../../scripts/install-auth-config.mjs');
    const probe = `
      const { spawnSync } = require('node:child_process');
      const { readFileSync } = require('node:fs');
      const { join } = require('node:path');
      const result = spawnSync(process.execPath, [process.argv[1], 'client-auth', 'set',
        '--client', 'openai', '--mode', 'api_key', '--api-key', 'isolated-fixture'], { encoding: 'utf8' });
      if (result.status !== 0) throw new Error(result.stderr);
      const accounts = JSON.parse(readFileSync(join(process.env.HOME, '.cat-cafe/accounts.json'), 'utf8'));
      const credentials = JSON.parse(readFileSync(join(process.env.HOME, '.cat-cafe/credentials.json'), 'utf8'));
      console.log(JSON.stringify({ ids: Object.keys(accounts), credentialIds: Object.keys(credentials) }));
    `;
    const result = spawnSync('bash', [withTestHome, 'node', '-e', probe, installer], {
      cwd: resolve(__dirname, '..'),
      env: { ...process.env, HOME: outerHome, CAT_CAFE_GLOBAL_CONFIG_ROOT: outerRoot },
      encoding: 'utf8',
    });
    for (const [name, content] of Object.entries(sentinels)) {
      assert.equal(readFileSync(join(configDir, name), 'utf8'), content, `outer ${name} must remain byte-identical`);
    }
    for (const name of ['provider-profiles.json', 'provider-profiles.secrets.local.json']) {
      assert.equal(readFileSync(join(outerHome, '.cat-cafe', name), 'utf8'), sentinels[name]);
    }
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { ids: ['installer-openai'], credentialIds: ['installer-openai'] });
  } finally {
    rmSync(outerRoot, { recursive: true, force: true });
  }
});

test('with-test-home enables write guards despite inherited sandbox bypass flags', () => {
  const result = spawnSync(
    'bash',
    [
      withTestHome,
      'node',
      '-e',
      'console.log(JSON.stringify([process.env.CAT_CAFE_TEST_SANDBOX, process.env.CAT_CAFE_TEST_SANDBOX_ALLOW_UNSAFE_ROOT ?? null]))',
    ],
    {
      cwd: resolve(__dirname, '..'),
      env: { ...process.env, CAT_CAFE_TEST_SANDBOX: '0', CAT_CAFE_TEST_SANDBOX_ALLOW_UNSAFE_ROOT: '1' },
      encoding: 'utf8',
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), ['1', null]);
});

test('with-test-home forces NODE_ENV=test even when outer shell is production', () => {
  const result = spawnSync('bash', [withTestHome, 'node', '-p', 'process.env.NODE_ENV'], {
    cwd: resolve(__dirname, '..'),
    env: {
      ...process.env,
      NODE_ENV: 'production',
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'test');
});

test('with-test-home strips runtime default cat override from outer shell', () => {
  const result = spawnSync('bash', [withTestHome, 'node', '-p', 'process.env.DEFAULT_CAT_ID ?? ""'], {
    cwd: resolve(__dirname, '..'),
    env: {
      ...process.env,
      DEFAULT_CAT_ID: 'codex',
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '');
});

test('with-test-home strips runtime API host binding from outer shell', () => {
  const result = spawnSync('bash', [withTestHome, 'node', '-p', 'process.env.API_SERVER_HOST ?? ""'], {
    cwd: resolve(__dirname, '..'),
    env: {
      ...process.env,
      API_SERVER_HOST: '0.0.0.0',
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '');
});

test('with-test-home strips the runtime Codex carrier from outer shell', () => {
  const result = spawnSync('bash', [withTestHome, 'node', '-p', 'process.env.CAT_CAFE_CODEX_CARRIER ?? ""'], {
    cwd: resolve(__dirname, '..'),
    env: {
      ...process.env,
      CAT_CAFE_CODEX_CARRIER: 'app_server',
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '');
});

test('with-test-home strips the runtime Claude carrier from outer shell', () => {
  const result = spawnSync('bash', [withTestHome, 'node', '-p', 'process.env.CAT_CAFE_CLAUDE_CARRIER ?? ""'], {
    cwd: resolve(__dirname, '..'),
    env: {
      ...process.env,
      CAT_CAFE_CLAUDE_CARRIER: 'bg_daemon',
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '');
});

for (const field of ['CODEX_HOME', 'CODEX_SQLITE_HOME']) {
  test(`with-test-home strips inherited ${field} before account fixtures load`, () => {
    const result = spawnSync('bash', [withTestHome, 'node', '-p', `process.env.${field} ?? ""`], {
      cwd: resolve(__dirname, '..'),
      env: { ...process.env, [field]: '/outer-owned-codex-fixture' },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), '');
  });
}

test('with-test-home allows the child fixture to select its own Codex roots', () => {
  const probe = `
    process.env.CODEX_HOME = process.env.HOME + '/fixture-auth';
    process.env.CODEX_SQLITE_HOME = process.env.HOME + '/fixture-state';
    console.log(JSON.stringify({
      home: process.env.HOME,
      auth: process.env.CODEX_HOME,
      state: process.env.CODEX_SQLITE_HOME,
      marker: process.env.TEST_HOME_FIXTURE_MARKER,
    }));
  `;
  const result = spawnSync('bash', [withTestHome, 'node', '-e', probe], {
    cwd: resolve(__dirname, '..'),
    env: {
      ...process.env,
      CODEX_HOME: '/outer-auth-fixture',
      CODEX_SQLITE_HOME: '/outer-state-fixture',
      TEST_HOME_FIXTURE_MARKER: 'preserved',
    },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const observed = JSON.parse(result.stdout);
  assert.equal(observed.auth, `${observed.home}/fixture-auth`);
  assert.equal(observed.state, `${observed.home}/fixture-state`);
  assert.equal(observed.marker, 'preserved');
});

// REDIS_URL is the one binding here that must be pinned rather than stripped.
// `packages/shared/src/utils/redis.ts` resolves it with a fallback to the
// protected endpoint, so an absent value selects that endpoint instead of
// selecting nothing. These two cases are the boundary; without them it is
// asserted only by a comment.
const REDIS_URL_PROBE = 'process.env.REDIS_URL ?? ""';

test('with-test-home pins REDIS_URL when the outer shell has none', () => {
  const outer = { ...process.env };
  delete outer.REDIS_URL;

  const result = spawnSync('bash', [withTestHome, 'node', '-p', REDIS_URL_PROBE], {
    cwd: resolve(__dirname, '..'),
    env: outer,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'redis://127.0.0.1:6398');
});

test('with-test-home overrides an inherited REDIS_URL instead of trusting it', () => {
  const result = spawnSync('bash', [withTestHome, 'node', '-p', REDIS_URL_PROBE], {
    cwd: resolve(__dirname, '..'),
    env: {
      ...process.env,
      REDIS_URL: 'redis://127.0.0.1:6399',
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'redis://127.0.0.1:6398');
});
