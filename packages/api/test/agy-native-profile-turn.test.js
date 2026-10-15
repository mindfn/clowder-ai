import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

const moduleUrl = new URL(
  '../dist/domains/cats/services/agents/providers/agy-native/agy-native-profile-turn.js',
  import.meta.url,
);
const { acquireAgyNativeProfileTurn } = await import(moduleUrl.href);
const { readUnixProcessSnapshotSync, sameUnixProcess } = await import('../dist/utils/cli-process-ownership.js');

test('Native profile takeover waits for dead owner descendants, then retires only orphan credentials', async () => {
  const home = mkdtempSync(join(tmpdir(), 'f325-profile-owner-'));
  const credentials = join(home, '.gemini/config/cat-cafe-credentials');
  mkdirSync(credentials, { recursive: true, mode: 0o700 });
  const credential = join(credentials, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.json');
  writeFileSync(credential, '{"invocationId":"orphan","callbackToken":"fixture"}', { mode: 0o600 });
  const owner = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import { spawn } from 'node:child_process';
    import { acquireAgyNativeProfileTurn } from ${JSON.stringify(moduleUrl.href)};
    acquireAgyNativeProfileTurn(process.env.HOME, 'orphan');
    const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true, stdio: 'ignore', env: process.env,
    });
    descendant.unref();
    console.log(JSON.stringify({ pid: descendant.pid }));
    setInterval(() => {}, 1000);
  `,
    ],
    { env: { ...process.env, HOME: home, CAT_CAFE_DATA_DIR: join(home, 'data') }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let descendant;
  try {
    const [data] = await once(owner.stdout, 'data');
    const { pid } = JSON.parse(data.toString());
    descendant = readUnixProcessSnapshotSync({ pids: [pid] })?.get(pid);
    assert.ok(descendant);
    assert.throws(() => acquireAgyNativeProfileTurn(home, 'successor'), /Another native turn/);
    owner.kill('SIGTERM');
    await once(owner, 'exit');
    assert.throws(() => acquireAgyNativeProfileTurn(home, 'successor'), /Another native turn/);
    assert.ok(existsSync(credential), 'a live descendant can still use the credential');
    process.kill(pid, 'SIGTERM');
    for (
      let i = 0;
      i < 100 && sameUnixProcess(descendant, readUnixProcessSnapshotSync({ pids: [pid] })?.get(pid));
      i++
    ) {
      await delay(20);
    }
    assert.equal(sameUnixProcess(descendant, readUnixProcessSnapshotSync({ pids: [pid] })?.get(pid)), false);
    const release = acquireAgyNativeProfileTurn(home, 'successor');
    assert.equal(existsSync(credential), false);
    release();
    const next = acquireAgyNativeProfileTurn(home, 'next');
    next();
  } finally {
    owner.kill('SIGTERM');
    if (
      descendant &&
      sameUnixProcess(descendant, readUnixProcessSnapshotSync({ pids: [descendant.pid] })?.get(descendant.pid))
    ) {
      process.kill(descendant.pid, 'SIGTERM');
    }
    rmSync(home, { recursive: true, force: true });
  }
});
