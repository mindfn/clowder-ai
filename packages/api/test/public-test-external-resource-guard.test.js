import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { assertDistributableCommand, assertDistributableUrl } from '../scripts/public-test-external-resource-guard.mjs';

describe('F308 public-test external resource guard', () => {
  it('allows process-local endpoints and local filesystem git transports', () => {
    for (const value of [
      'http://127.0.0.1:3004/health',
      'http://localhost:3004/health',
      'ws://[::1]:9876/socket',
      'file:///tmp/fixture.json',
    ]) {
      assert.doesNotThrow(() => assertDistributableUrl(value, 'fixture'));
    }
    assert.doesNotThrow(() => assertDistributableCommand('git', ['fetch', '/tmp/repo.git', 'main']));
    assert.doesNotThrow(() => assertDistributableCommand('curl', ['http://127.0.0.1:3004/health']));
  });

  it('rejects real non-loopback endpoints and network-capable commands before I/O', () => {
    assert.throws(
      () => assertDistributableUrl('https://api.github.com/repos/zts212653/clowder-ai', 'fetch'),
      /external_resource_violation/,
    );
    assert.throws(() => assertDistributableCommand('gh', ['api', '/repos/a/b']), /external_resource_violation/);
    assert.throws(
      () => assertDistributableCommand('curl', ['https://example.com/fixture']),
      /external_resource_violation/,
    );
    assert.throws(
      () => assertDistributableCommand('sh', ['-c', 'wget https://example.com/fixture']),
      /external_resource_violation/,
    );
  });

  it('does not confuse fixture strings or harmless local commands with external use', () => {
    assert.doesNotThrow(() => assertDistributableCommand('node', ['-e', 'console.log("gh ssh curl")']));
    assert.doesNotThrow(() => assertDistributableCommand('git', ['status', '--short']));
    assert.doesNotThrow(() => assertDistributableCommand('sh', ['-c', 'printf "gh ssh curl"']));
  });

  it('blocks a real external fetch in a guarded child before network I/O', () => {
    const guardPath = fileURLToPath(new URL('../scripts/public-test-external-resource-guard.mjs', import.meta.url));
    const result = spawnSync(
      process.execPath,
      ['--import', guardPath, '--eval', 'await fetch("https://example.com/should-not-run")'],
      {
        encoding: 'utf8',
        env: { ...process.env, CAT_CAFE_PUBLIC_TEST_RESOURCE_SCOPE: 'distributable' },
      },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /external_resource_violation/);
  });

  it('preserves child_process promisify semantics while guarding commands', () => {
    const guardPath = fileURLToPath(new URL('../scripts/public-test-external-resource-guard.mjs', import.meta.url));
    const script = [
      'const { promisify } = await import("node:util");',
      'const { execFile } = await import("node:child_process");',
      'const { stdout } = await promisify(execFile)(process.execPath, ["--version"]);',
      'if (!stdout.startsWith("v")) process.exit(2);',
    ].join('');
    const result = spawnSync(process.execPath, ['--import', guardPath, '--eval', script], {
      encoding: 'utf8',
      env: { ...process.env, CAT_CAFE_PUBLIC_TEST_RESOURCE_SCOPE: 'distributable' },
    });
    assert.equal(result.status, 0, result.stderr);
  });
});
