import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const withTestHome = resolve(__dirname, '../scripts/with-test-home.sh');

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
  assert.equal(result.stdout.trim(), 'redis://127.0.0.1:0');
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
  assert.equal(result.stdout.trim(), 'redis://127.0.0.1:0');
});
