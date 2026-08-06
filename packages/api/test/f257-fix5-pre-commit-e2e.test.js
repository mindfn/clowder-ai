/**
 * F257 #5 修复 — pre-commit hook 全链 e2e 矩阵测试。
 *
 * sol R2 补缺：白名单脚本的单元测试（f257-fix5-develop-base-allowlist.test.js）不等于
 * 全链 e2e 覆盖 — pre-commit 含 Root Hygiene / Develop-base Guard / Biome / Brand /
 * Shared State Guard 五层门禁，白名单脚本仅其一。
 *
 * 三态矩阵（Fable 架构裁决要求的最小可行集）：
 *   1. develop_base + cat-config.json → exit 0（白名单放行，全链通过）
 *   2. develop_base + packages/x.ts → exit 1（代码改动被拦）
 *   3. feat 分支 + docs/BACKLOG.md → exit 1（Shared State Guard 拦截）
 *
 * 方法：stub pnpm/node 于 PATH + tmp git repo，用真实 pre-commit hook 跑 git commit。
 */

import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const PRE_COMMIT_SRC = resolve(REPO_ROOT, '.githooks', 'pre-commit');
const ALLOWLIST_SRC = resolve(REPO_ROOT, 'scripts', 'check-develop-base-allowlist.sh');

/** Create a disposable git repo with the real pre-commit hook + stub pnpm/node. */
function setupTestRepo(branch) {
  const tmpDir = mkdtempSync(join(tmpdir(), 'pre-commit-e2e-'));
  const binDir = join(tmpDir, '_bin');
  mkdirSync(binDir);

  // Stub pnpm and node — both just exit 0 (biome guard / brand dictionary guard skip)
  writeFileSync(join(binDir, 'pnpm'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(binDir, 'node'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
  mkdirSync(join(tmpDir, 'node_modules', '@biomejs', 'biome'), { recursive: true });
  writeFileSync(join(tmpDir, 'node_modules', '@biomejs', 'biome', 'package.json'), '{}');
  mkdirSync(join(tmpDir, 'node_modules', '.bin'), { recursive: true });
  writeFileSync(join(tmpDir, 'node_modules', '.bin', 'biome'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });

  const run = (cmd) => execSync(cmd, { cwd: tmpDir, stdio: 'pipe' });
  run('git init');
  run('git config user.email "test@e2e.local"');
  run('git config user.name "e2e"');

  // Copy real hooks and scripts
  mkdirSync(join(tmpDir, '.githooks'));
  cpSync(PRE_COMMIT_SRC, join(tmpDir, '.githooks', 'pre-commit'));
  chmodSync(join(tmpDir, '.githooks', 'pre-commit'), 0o755);
  mkdirSync(join(tmpDir, 'scripts'));
  cpSync(ALLOWLIST_SRC, join(tmpDir, 'scripts', 'check-develop-base-allowlist.sh'));
  chmodSync(join(tmpDir, 'scripts', 'check-develop-base-allowlist.sh'), 0o755);

  // Set hook path
  run('git config core.hooksPath .githooks');

  // Initial commit (--no-verify to bootstrap without triggering the hook)
  run('git add .githooks scripts');
  run('git commit --no-verify -m "bootstrap hooks"');

  // Switch to target branch
  run(`git checkout -b ${branch}`);

  const env = { ...process.env, PATH: `${binDir}:${process.env.PATH}` };
  return { tmpDir, env, cleanup: () => rmSync(tmpDir, { recursive: true, force: true }) };
}

/** Stage a file and attempt git commit — returns { code, stderr }. */
function tryCommit(tmpDir, env) {
  try {
    execSync('git commit -m "e2e-test"', { cwd: tmpDir, env, stdio: 'pipe' });
    return { code: 0, stderr: '' };
  } catch (err) {
    return { code: err.status ?? 1, stderr: String(err.stderr ?? '') };
  }
}

describe('F257 #5 修复：pre-commit hook 全链 e2e（三态矩阵）', () => {
  const cleanups = [];
  after(() => {
    for (const fn of cleanups) fn();
  });

  it('develop_base + cat-config.json → exit 0（全链通过：Hygiene✓ → DB-Guard✓ → Biome✓ → Brand✓ → skip SS）', () => {
    const { tmpDir, env, cleanup } = setupTestRepo('develop_base');
    cleanups.push(cleanup);
    writeFileSync(join(tmpDir, 'cat-config.json'), '{}');
    execSync('git add cat-config.json', { cwd: tmpDir, stdio: 'pipe' });
    const { code, stderr } = tryCommit(tmpDir, env);
    assert.equal(code, 0, `cat-config.json on develop_base must pass the full hook chain\n${stderr}`);
  });

  it('develop_base + packages/x.ts → exit 1（Develop-base Runtime Guard 拦截代码改动）', () => {
    const { tmpDir, env, cleanup } = setupTestRepo('develop_base');
    cleanups.push(cleanup);
    mkdirSync(join(tmpDir, 'packages'));
    writeFileSync(join(tmpDir, 'packages', 'x.ts'), 'export {};');
    execSync('git add packages/x.ts', { cwd: tmpDir, stdio: 'pipe' });
    const { code, stderr } = tryCommit(tmpDir, env);
    assert.equal(code, 1, 'code file on develop_base must be rejected by allowlist');
    assert.match(stderr, /packages\/x\.ts/, 'error must name the violating file');
  });

  it('feat 分支 + docs/BACKLOG.md → exit 1（Shared State Guard 拦截共享状态文件）', () => {
    const { tmpDir, env, cleanup } = setupTestRepo('feat/test');
    cleanups.push(cleanup);
    mkdirSync(join(tmpDir, 'docs'));
    writeFileSync(join(tmpDir, 'docs', 'BACKLOG.md'), '# BACKLOG');
    execSync('git add docs/BACKLOG.md', { cwd: tmpDir, stdio: 'pipe' });
    const { code, stderr } = tryCommit(tmpDir, env);
    assert.equal(code, 1, 'shared state file on feat branch must be rejected');
    assert.match(stderr, /SHARED-STATE GUARD/, 'must be caught by Shared State Guard, not other guards');
  });
});
