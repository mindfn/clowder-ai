/**
 * F257 修复清单 #5 — 运行实例写保护：develop_base 分支 commit 白名单。
 *
 * 证据坐标：dev-af6d4e28（平行实例任务错位 merge 污染运行基线，V1 一度整体不在运行树）。
 * 目标：把 LI-004「运行实例对代码只读」从认知纪律降为结构强制。
 *
 * 契约（scripts/check-develop-base-allowlist.sh，pre-commit 调用）：
 *   - 仅 branch == develop_base 时启用白名单；其他分支一律放行（不影响 feature 开发）
 *   - 白名单 = §14 共享状态文档：docs、review-notes、根目录 BACKLOG.md / ROADMAP.md、
 *     assets 下任意深度的 .md（知识文档；二进制资产不在内）
 *   - 其余路径（packages、scripts、cat-template.json、cat-cafe-skills …）→ exit 1 拒绝
 *   - stdin 收 staged 文件列表（一行一个），$1 = branch
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(__dirname, '..', '..', '..', 'scripts', 'check-develop-base-allowlist.sh');

/** run script with branch + staged file list; returns {code, stderr} */
function run(branch, files) {
  try {
    execFileSync('bash', [SCRIPT, branch], { input: `${files.join('\n')}\n`, stdio: ['pipe', 'pipe', 'pipe'] });
    return { code: 0, stderr: '' };
  } catch (err) {
    return { code: err.status ?? 1, stderr: String(err.stderr ?? '') };
  }
}

describe('F257 #5 修复：develop_base 白名单脚本存在性', () => {
  it('scripts/check-develop-base-allowlist.sh 存在', () => {
    assert.ok(existsSync(SCRIPT), `expected allowlist script at ${SCRIPT}`);
  });
});

describe('F257 #5 修复：develop_base 分支白名单强制', () => {
  it('代码文件（packages/**）→ 拒绝', () => {
    const { code, stderr } = run('develop_base', ['packages/api/src/index.ts']);
    assert.equal(code, 1);
    assert.match(stderr, /packages\/api\/src\/index\.ts/);
  });

  it('共享状态文档（docs/** / review-notes/** / BACKLOG.md / ROADMAP.md）→ 放行', () => {
    const { code } = run('develop_base', [
      'docs/features/F257-harness-ledger.md',
      'docs/bug-report/some/bug-report.md',
      'review-notes/2026-07-19-review.md',
      'BACKLOG.md',
      'ROADMAP.md',
    ]);
    assert.equal(code, 0);
  });

  it('assets 下 markdown 知识文档 → 放行；assets 下二进制 → 拒绝', () => {
    assert.equal(run('develop_base', ['assets/F257/objective-driven-redesign-v1.md']).code, 0);
    assert.equal(run('develop_base', ['assets/screenshots/foo.png']).code, 1);
  });

  it('混合 staged（文档 + 代码）→ 拒绝并点名代码文件', () => {
    const { code, stderr } = run('develop_base', ['docs/features/F257-harness-ledger.md', 'packages/api/src/x.ts']);
    assert.equal(code, 1);
    assert.match(stderr, /packages\/api\/src\/x\.ts/);
    assert.doesNotMatch(stderr, /F257-harness-ledger\.md/);
  });

  it('配置与 hook 自身（cat-template.json / .githooks/** / scripts/**）→ 拒绝（改动必须走 PR）', () => {
    assert.equal(run('develop_base', ['cat-template.json']).code, 1);
    assert.equal(run('develop_base', ['.githooks/pre-commit']).code, 1);
    assert.equal(run('develop_base', ['scripts/check-develop-base-allowlist.sh']).code, 1);
  });

  it('cat-cafe-skills/** → 拒绝（skill 改动走 PR 回流）', () => {
    assert.equal(run('develop_base', ['cat-cafe-skills/refs/shared-rules.md']).code, 1);
  });

  it('路径前缀伪装（docs-evil/x.md、fake-review-notes/y.md）→ 拒绝', () => {
    assert.equal(run('develop_base', ['docs-evil/x.md']).code, 1);
    assert.equal(run('develop_base', ['fake-review-notes/y.md']).code, 1);
  });

  it('空 staged 列表 → 放行（允许 --allow-empty 等元操作）', () => {
    assert.equal(run('develop_base', []).code, 0);
  });
});

describe('F257 #5 修复：非 develop_base 分支不受白名单限制', () => {
  it('feature 分支改代码 → 放行', () => {
    assert.equal(run('feat/harness-fix-a', ['packages/api/src/index.ts']).code, 0);
  });

  it('main 分支改代码 → 放行（上游语义不变）', () => {
    assert.equal(run('main', ['packages/api/src/index.ts']).code, 0);
  });
});
