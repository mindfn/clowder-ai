import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { diffDerivedKeys } from './checks/derived-keys.mjs';
import { checkF8, L0_FILES } from './checks/f8.mjs';
import { checkUnbound } from './checks/unbound.mjs';
import { parseArgs, resolveChecks } from './lib/args.mjs';
import { combine, exitCode, fail, pass, unbound } from './lib/report.mjs';

describe('args', () => {
  it('requires a mode, redis url and baseline path', () => {
    assert.throws(() => parseArgs([], {}), /mode_required/);
    assert.throws(() => parseArgs(['baseline'], {}), /redis_url_required/);
    assert.throws(() => parseArgs(['baseline', '--redis-url', 'redis://x'], {}), /baseline_path_required/);
  });
  it('requires api url only when an API-backed check is selected', () => {
    const base = ['verify', '--redis-url', 'redis://x', '--baseline', '/tmp/b.json'];
    assert.throws(() => parseArgs([...base, '--checks', 'F-6'], {}), /api_url_required/);
    const options = parseArgs([...base, '--checks', 'F-2,F-8'], {});
    assert.deepEqual(options.checks, ['F-2', 'F-8']);
    assert.equal(options.ownerUserId, 'default-user');
  });
  it('rejects unknown checks and arguments', () => {
    assert.throws(() => resolveChecks('F-9'), /unknown_check:F-9/);
    assert.throws(() => parseArgs(['baseline', '--bogus'], {}), /unknown_argument/);
  });
});

describe('derived key baseline diff', () => {
  it('reports only keys that appeared after the baseline', () => {
    const baseline = { keys: { unitJob: ['a:1'], sweepJob: [] } };
    const current = { keys: { unitJob: ['a:1', 'a:2'], sweepJob: ['s:1'], snapshot: [] } };
    const diff = diffDerivedKeys(baseline, current);
    assert.equal(diff.addedCount, 2);
    assert.deepEqual(diff.added, { unitJob: ['a:2'], sweepJob: ['s:1'] });
  });
});

describe('report', () => {
  it('fail dominates, unbound is never a pass, only all-pass exits 0', () => {
    assert.equal(combine('F-x', [pass('F-x', 'a'), unbound('F-x', 'b'), fail('F-x', 'c')]).status, 'fail');
    assert.equal(combine('F-x', [pass('F-x', 'a'), unbound('F-x', 'b')]).status, 'unbound');
    assert.equal(combine('F-x', [pass('F-x', 'a')]).status, 'pass');
    assert.equal(exitCode([pass('F-1', 'a'), unbound('F-2', 'b')]), 1);
    assert.equal(exitCode([pass('F-1', 'a'), pass('F-2', 'b')]), 0);
    assert.equal(exitCode([]), 1);
    assert.equal(checkUnbound('F-7').status, 'unbound');
  });
});

describe('F-8 code-tree residue', () => {
  it('fails while any L0 compiler file exists and stays unbound (not pass) once removed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'f257-f8-'));
    try {
      const present = join(root, L0_FILES[0]);
      mkdirSync(dirname(present), { recursive: true });
      writeFileSync(present, '// legacy');
      assert.equal((await checkF8({ projectRoot: root })).status, 'fail');
      rmSync(present);
      const result = await checkF8({ projectRoot: root });
      assert.equal(result.status, 'unbound');
      assert.equal(result.evidence.parts[0].status, 'pass');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
