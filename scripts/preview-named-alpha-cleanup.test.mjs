import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { deriveNamedAlphaCoordinates, namedAlphaEnvironment } from './lib/alpha-coordinates.mjs';
import { namedAlphaFixture } from './lib/alpha-named-fixture.mjs';
import { captureNamedAlphaRedisIdentity, verifyNamedAlphaRedisIdentity } from './lib/alpha-redis-process.mjs';

const cli = join(dirname(fileURLToPath(import.meta.url)), 'preview-process.mjs');

function listenerProbeFixture(directory, port, mode) {
  if (!mode) return null;
  const bin = join(directory, 'listener-probe-bin');
  mkdirSync(bin);
  const armed = join(directory, 'listener-probe-armed');
  const observed = join(directory, 'listener-probe-timeouts');
  const native = execFileSync('which', ['lsof'], { encoding: 'utf8' }).trim();
  writeFileSync(
    join(bin, 'lsof'),
    `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('-iTCP:${port}') && fs.existsSync(${JSON.stringify(armed)}) &&
    (${JSON.stringify(mode)} === 'always' || !fs.existsSync(${JSON.stringify(observed)}))) {
  fs.appendFileSync(${JSON.stringify(observed)}, 'timeout\\n');
  setTimeout(() => process.exit(1), 10000);
} else {
  const result = require('node:child_process').spawnSync(${JSON.stringify(native)}, args, { stdio: 'inherit' });
  process.exit(result.status ?? 1);
}
`,
    { mode: 0o755 },
  );
  return { bin, armed, observed };
}

for (const [verificationFails, earlyWrapper, missingResult, pnpmWrapper, listenerTimeoutMode] of [
  [false, false, false],
  [true, false, false],
  [false, true, false],
  [true, true, false],
  [false, true, true],
  [false, false, false, true],
  [true, false, false, true],
  [false, false, false, false, 'once'],
  [false, false, false, false, 'always'],
]) {
  const cleanupRefused = verificationFails || listenerTimeoutMode === 'always';
  test(`canonical preview stop ${cleanupRefused ? 'reports refused Redis cleanup and retains ownership' : 'saves Redis and releases the producer lease'}${earlyWrapper ? ' after an early wrapper exit' : ''}${missingResult ? ' but rejects an unpublished owner result' : ''}${pnpmWrapper ? ' through real pnpm' : ''}${listenerTimeoutMode ? ` after ${listenerTimeoutMode} lsof timeout` : ''}`, async (t) => {
    const disposals = [];
    const f = namedAlphaFixture({ after: (fn) => disposals.push(fn) });
    const sockets = [];
    for (let index = 0; index < 5; index += 1) {
      const socket = net.createServer();
      await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
      sockets.push(socket);
    }
    const ports = sockets.map((socket) => socket.address().port);
    await Promise.all(sockets.map((socket) => new Promise((resolve) => socket.close(resolve))));
    // Exercise the actual launcher/storage/cleanup code. Only replace application
    // startup with a private HTTP child; no build, model invocation or shared DB.
    const entry = join(f.mainRoot, 'scripts/start-dev.sh');
    const source = readFileSync(entry, 'utf8');
    assert.ok(source.endsWith('main "$@"\n'));
    writeFileSync(entry, source.replace(/main "\$@"\n$/, 'source "$ALPHA_TEST_DRIVER"\n'));
    writeFileSync(
      join(f.mainRoot, 'package.json'),
      JSON.stringify({ private: true, scripts: { start: 'bash ./scripts/start-dev.sh --quick' } }),
    );
    f.git(['add', 'scripts/start-dev.sh', 'package.json']);
    f.git(['commit', '-m', 'exercise real managed Alpha cleanup']);
    f.git(['push', 'origin', 'main']);
    f.git(['fetch', 'origin', 'main']);
    f.git(['merge', '--ff-only', 'origin/main'], f.alphaRoot);
    const head = f.git(['rev-parse', 'HEAD'], f.alphaRoot);
    f.preparedBuilds(head);
    const coordinates = deriveNamedAlphaCoordinates({
      mainRoot: f.mainRoot,
      instance: 'f290-communication',
      ports: ports.join(','),
      targetSha: head,
    });
    const raw = JSON.stringify(coordinates);
    const directory = join(f.alphaRoot, '.cat-cafe/redis');
    const pidFile = join(directory, `redis-${ports[4]}.pid`);
    const registry = join(f.directory, 'leases');
    const driver = join(f.directory, 'driver.sh');
    const probe = listenerProbeFixture(f.directory, ports[4], listenerTimeoutMode);
    writeFileSync(
      join(f.directory, 'server.cjs'),
      `require('node:http').createServer((q,s)=>s.end('alpha fixture')).listen(${ports[0]},'127.0.0.1');`,
    );
    writeFileSync(
      driver,
      `set -e
setup_storage
redis-cli -p "$REDIS_PORT" set preview-cleanup-marker preserved
"${process.execPath}" "${join(f.directory, 'server.cjs')}" &
register_managed_pid "$!"
${verificationFails ? 'named_alpha_redis_is_owned() { return 1; }' : ''}
${missingResult ? 'publish_preview_cleanup_result() { :; }' : ''}
${probe ? `touch '${probe.armed}'` : ''}
wait
`,
    );
    const env = { ...process.env, CAT_CAFE_PREVIEW_PROCESS_DIR: join(f.directory, 'preview-state') };
    const id = createHash('sha256').update(`${f.alphaRoot}\0${ports[0]}`).digest('hex').slice(0, 16);
    const recordPath = join(env.CAT_CAFE_PREVIEW_PROCESS_DIR, `${id}.json`);
    let previewRecord;
    const run = (action, extra = []) =>
      spawnSync(process.execPath, [cli, action, '--port', String(ports[0]), '--cwd', f.alphaRoot, '--json', ...extra], {
        env,
        encoding: 'utf8',
        timeout: 45_000,
      });
    let cleanupProven = false;
    t.after(() => {
      run('stop');
      // A failed regression must still keep data and never bypass identity proof.
      if (existsSync(pidFile)) {
        const proof = captureNamedAlphaRedisIdentity(raw);
        verifyNamedAlphaRedisIdentity(raw, proof);
        execFileSync('redis-cli', ['-h', '127.0.0.1', '-p', String(ports[4]), 'shutdown', 'save']);
      }
      if (previewRecord?.origin === 'launchd') {
        spawnSync('launchctl', ['bootout', `gui/${process.getuid()}/${previewRecord.launchdLabel}`]);
      }
      if (cleanupProven) for (const dispose of disposals) dispose();
    });
    const assignments = Object.entries({
      ...namedAlphaEnvironment(coordinates),
      HOME: f.env.HOME,
      PATH: probe ? `${probe.bin}:${process.env.PATH}` : process.env.PATH,
      CAT_CAFE_SKIP_NODE_RUNTIME_GUARD: '1',
      CAT_CAFE_ALPHA_REDIS_REGISTRY_DIR: registry,
      ALPHA_TEST_DRIVER: driver,
    }).map(([key, value]) => `${key}=${value}`);
    const wrapper = join(f.directory, 'wrapper.cjs');
    writeFileSync(
      wrapper,
      `const {spawn}=require('node:child_process');
spawn('/bin/bash',['./scripts/start-dev.sh','--quick'],{stdio:'inherit'});
process.on('SIGTERM',()=>process.exit(143));
setInterval(()=>{},1000);`,
    );
    const launcher = earlyWrapper
      ? [process.execPath, wrapper]
      : pnpmWrapper
        ? ['pnpm', 'run', 'start']
        : ['/bin/bash', './scripts/start-dev.sh', '--quick'];
    const started = run('start', ['--', '/usr/bin/env', ...assignments, ...launcher]);
    assert.equal(started.status, 0, started.stderr || started.stdout);
    previewRecord = JSON.parse(readFileSync(recordPath, 'utf8'));
    const proof = captureNamedAlphaRedisIdentity(raw);
    verifyNamedAlphaRedisIdentity(raw, proof);
    assert.equal(readdirSync(registry).length, 1, 'producer registered its own Redis lease');
    const stopped = run('stop');
    if (probe) assert.ok(existsSync(probe.observed), 'exercise an actual timed-out native listener probe');
    if (cleanupRefused) {
      assert.equal(stopped.status, 1, stopped.stderr || stopped.stdout);
      verifyNamedAlphaRedisIdentity(raw, proof);
      assert.equal(readdirSync(registry).length, 1, 'failed cleanup preserves the original lease');
      assert.equal(existsSync(recordPath), true, 'failed cleanup preserves the preview record');
      cleanupProven = true;
      return;
    }
    assert.equal(stopped.status, missingResult ? 1 : 0, stopped.stderr || stopped.stdout);
    assert.equal(existsSync(recordPath), missingResult, 'missing owner result retains preview evidence');
    assert.equal(existsSync(pidFile), false, 'Redis must have exited before stopped');
    assert.deepEqual(readdirSync(registry), [], 'producer must release its own Redis lease');
    const rdb = readFileSync(join(directory, 'dump.rdb'));
    assert.ok(rdb.includes(Buffer.from('preview-cleanup-marker')), 'shutdown save preserves the written key');
    assert.ok(rdb.includes(Buffer.from('preserved')));
    cleanupProven = true;
  });
}
