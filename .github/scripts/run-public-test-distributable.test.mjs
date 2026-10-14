import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync, statSync } from 'node:fs';
import { describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const launcher = fileURLToPath(new URL('./run-public-test-distributable.sh', import.meta.url));
const commandRunner = new URL('../../packages/api/scripts/redis-test-processes.mjs', import.meta.url).href;
const namespaceProbe = new URL('../../packages/api/scripts/public-test-isolation-preflight.mjs', import.meta.url).href;
const resourceGuard = fileURLToPath(
  new URL('../../packages/api/scripts/public-test-external-resource-guard.mjs', import.meta.url),
);
const requiresRootLinux = process.platform !== 'linux' || process.getuid() !== 0;
// Match the actual checkout owner on hosted runners; a made-up uid cannot
// traverse runner-private parent directories after setpriv.
const runnerUid = process.env.SUDO_UID ?? '1000';
const runnerGid = process.env.SUDO_GID ?? '1000';
const args = (code) => [
  launcher,
  runnerUid,
  runnerGid,
  process.env.PATH,
  process.execPath,
  '--import',
  resourceGuard,
  '-e',
  code,
];
const run = (code, { isolated = true } = {}) =>
  spawnSync(isolated ? 'unshare' : launcher, isolated ? ['--net', '--', ...args(code)] : args(code).slice(1), {
    encoding: 'utf8',
    timeout: 15_000,
    killSignal: 'SIGKILL',
    env: {
      ...process.env,
      CAT_CAFE_PUBLIC_TEST_NETNS_PROOF: '/forged/path',
      CAT_CAFE_PUBLIC_TEST_RESOURCE_SCOPE: 'distributable',
    },
  });

const nondumpablePython = `
import ctypes, os, time
if os.getuid() == 0:
    os.setgroups([])
    os.setgid(${Number(runnerGid)})
    os.setuid(${Number(runnerUid)})
assert ctypes.CDLL(None, use_errno=True).prctl(4, 0, 0, 0, 0) == 0
print('ready', flush=True)
time.sleep(60)
`;

async function ready(child) {
  let timer;
  try {
    const [chunk] = await Promise.race([
      once(child.stdout, 'data'),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('fixture did not start')), 5000);
      }),
    ]);
    assert.equal(chunk.toString().trim(), 'ready');
  } finally {
    clearTimeout(timer);
  }
}

describe(
  'public-test launcher kernel receipt',
  { skip: requiresRootLinux && 'requires isolated Linux root to create a network namespace' },
  () => {
    it('emits a protected receipt for the exact child namespace before dropping all privileges', () => {
      const child = run(`
      const assert = require('node:assert/strict');
      const fs = require('node:fs');
      const path = require('node:path');
      const receiptPath = process.env.CAT_CAFE_PUBLIC_TEST_NETNS_PROOF;
      assert.notEqual(receiptPath, '/forged/path');
      const directory = fs.lstatSync(path.dirname(receiptPath));
      const file = fs.lstatSync(receiptPath);
      assert.equal(directory.uid, 0);
      assert.equal(directory.mode & 0o777, 0o755);
      assert.equal(file.uid, 0);
      assert.equal(file.mode & 0o777, 0o444);
      assert.ok(file.isFile() && !file.isSymbolicLink());
      assert.throws(() => fs.openSync(receiptPath, 'w'), { code: 'EACCES' });
      assert.throws(() => fs.unlinkSync(receiptPath), { code: 'EACCES' });
      const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
      const ns = fs.statSync('/proc/self/ns/net', { bigint: true });
      assert.equal(receipt.schemaVersion, 1);
      assert.equal(receipt.isolated, ns.dev + ':' + ns.ino);
      assert.notEqual(receipt.host, receipt.isolated);
      assert.equal(receipt.bootId, fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim());
      assert.match(receipt.nonce, /^[a-f0-9-]{36}$/);
      assert.notEqual(process.getuid(), 0);
      process.stdout.write(JSON.stringify({ receipt: 'verified', nonce: receipt.nonce }));
    `);
      assert.equal(child.status, 0, child.stdout + child.stderr);
      assert.equal(JSON.parse(child.stdout).receipt, 'verified');
    });

    it('refuses same-host launch rather than issuing proof for an empty route table', () => {
      const child = run('process.stdout.write("must-not-run")', { isolated: false });
      assert.equal(child.status, 1, child.stdout + child.stderr);
      assert.match(child.stderr, /shares the host network namespace/);
      assert.doesNotMatch(child.stdout, /must-not-run/);
    });

    it('preserves the command exit status through the privilege boundary', () => {
      const child = run('process.exit(37)');
      assert.equal(child.status, 37, child.stdout + child.stderr);
    });

    it('refuses the process-domain stage without a fresh namespace and matching procfs', () => {
      const ns = statSync('/proc/self/ns/pid', { bigint: true });
      const child = spawnSync(
        launcher,
        [
          '--verify-process-domain',
          `${ns.dev}:${ns.ino}`,
          runnerUid,
          runnerGid,
          process.env.PATH,
          process.execPath,
          '-e',
          'process.stdout.write("must-not-run")',
        ],
        { encoding: 'utf8', timeout: 5000 },
      );
      assert.equal(child.status, 1, child.stdout + child.stderr);
      assert.match(child.stderr, /procfs is not bound to a fresh process namespace/);
      assert.doesNotMatch(child.stdout, /must-not-run/);
    });

    it('isolates cleanup from a live same-UID non-dumpable host process', async () => {
      const host = spawn('/usr/bin/python3', ['-c', nondumpablePython], { stdio: ['ignore', 'pipe', 'inherit'] });
      const hostExited = once(host, 'exit');
      try {
        await ready(host);
        const denied = spawnSync(
          'setpriv',
          [
            '--reuid',
            runnerUid,
            '--regid',
            runnerGid,
            '--clear-groups',
            process.execPath,
            '-e',
            `
            require('node:assert/strict').throws(() => require('node:fs').readFileSync('/proc/${host.pid}/environ'), { code: 'EACCES' });
          `,
          ],
          { encoding: 'utf8', timeout: 5000 },
        );
        assert.equal(denied.status, 0, denied.stdout + denied.stderr);
        const parent = statSync('/proc/self/ns/pid', { bigint: true });
        const child = run(`
          (async () => {
            const assert = require('node:assert/strict');
            const fs = require('node:fs');
            const self = fs.statSync('/proc/self/ns/pid', { bigint: true });
            const init = fs.statSync('/proc/1/ns/pid', { bigint: true });
            assert.equal(process.pid, 1);
            assert.equal(self.ino, init.ino);
            assert.notEqual(self.dev + ':' + self.ino, ${JSON.stringify(`${parent.dev}:${parent.ino}`)});
            const { detectKernelNetworkBoundary } = await import(${JSON.stringify(namespaceProbe)});
            assert.equal(detectKernelNetworkBoundary(), 'verified');
            const { runTestCommand } = await import(${JSON.stringify(commandRunner)});
            process.exitCode = await runTestCommand([process.execPath, '-e', ''], {
              cwd: process.cwd(), env: {}, signal: new AbortController().signal,
            });
          })().catch(error => { console.error(error); process.exitCode = 1; });
        `);
        assert.equal(child.status, 0, child.stdout + child.stderr);
        assert.equal(host.exitCode, null);
        process.kill(host.pid, 0); // Isolation did not signal the host fixture.
      } finally {
        host.kill('SIGKILL');
        await hostExited;
      }
    });

    it('still rejects an unreadable same-domain process instead of granting cleanup proof', () => {
      const child = run(`
        (async () => {
          const { spawn } = require('node:child_process');
          const { once } = require('node:events');
          const denied = spawn('/usr/bin/python3', ['-c', ${JSON.stringify(nondumpablePython)}], { stdio: ['ignore', 'pipe', 'inherit'] });
          const exited = once(denied, 'exit');
          try {
            await once(denied.stdout, 'data');
            const { runTestCommand } = await import(${JSON.stringify(commandRunner)});
            process.exitCode = await runTestCommand([process.execPath, '-e', ''], {
              cwd: process.cwd(), env: {}, signal: new AbortController().signal,
            });
          } finally { denied.kill('SIGKILL'); await exited; }
        })().catch(error => { console.error(error); process.exitCode = 2; });
      `);
      assert.equal(child.status, 1, child.stdout + child.stderr);
      assert.match(child.stderr, /cleanup=unknown killed=0/);
      assert.match(child.stderr, /"operation":"proc-environ","code":"EACCES"/);
    });

    it('detects and cleans a token-owned detached descendant while failing the leaking command', () => {
      const child = run(`
        (async () => {
          const { runTestCommand } = await import(${JSON.stringify(commandRunner)});
          process.exitCode = await runTestCommand([process.execPath, '-e',
            "require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' }).unref()"
          ], { cwd: process.cwd(), env: {}, signal: new AbortController().signal });
        })().catch(error => { console.error(error); process.exitCode = 2; });
      `);
      assert.equal(child.status, 1, child.stdout + child.stderr);
      assert.match(child.stderr, /cleanup=proven killed=1/);
    });

    it('tears down namespace init when its owned root monitor is killed', async () => {
      const monitor = spawn('unshare', ['--net', '--', ...args("console.log('ready'); setInterval(() => {}, 1000)")], {
        stdio: ['ignore', 'pipe', 'inherit'],
      });
      const exited = once(monitor, 'exit');
      try {
        await ready(monitor);
        const children = spawnSync('ps', ['--ppid', String(monitor.pid), '-o', 'pid='], {
          encoding: 'utf8',
          timeout: 5000,
        });
        assert.equal(children.status, 0, children.stderr);
        const pids = children.stdout.trim().split(/\s+/).map(Number);
        assert.equal(pids.length, 1, 'unshare must own one namespace init');
        const pid = pids[0];
        assert.ok(Number.isSafeInteger(pid) && pid > 1);
        const identity = () => {
          try {
            const text = readFileSync(`/proc/${pid}/stat`, 'utf8');
            const fields = text.slice(text.lastIndexOf(')') + 2).split(' ');
            return { state: fields[0], birth: fields[19] };
          } catch (error) {
            if (error.code === 'ENOENT' || error.code === 'ESRCH') return null;
            throw error;
          }
        };
        const original = identity();
        assert.ok(original?.birth);
        monitor.kill('SIGKILL');
        await exited;
        const deadline = Date.now() + 5000;
        while (true) {
          const current = identity();
          if (!current || current.birth !== original.birth || current.state === 'Z') break;
          assert.ok(Date.now() < deadline, 'namespace init survived its monitor');
          await delay(25);
        }
      } finally {
        if (monitor.exitCode === null && monitor.signalCode === null) monitor.kill('SIGKILL');
        await exited;
      }
    });
  },
);
