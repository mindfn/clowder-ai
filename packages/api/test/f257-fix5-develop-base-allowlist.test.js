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

  // sol R2 P1-3: 白名单收窄为穷举五项（§14 + local override 严格推导）
  it('穷举白名单五项 → 放行', () => {
    const { code } = run('develop_base', [
      'BACKLOG.md',
      'ROADMAP.md',
      'cat-config.json',
      'cat-cafe-skills/refs/shared-rules.local.md',
      'docs/BACKLOG.md',
    ]);
    assert.equal(code, 0);
  });

  it('docs/** 非穷举项（feat-doc 等）→ 拒绝（改走 PR 或 --no-verify）', () => {
    assert.equal(run('develop_base', ['docs/features/F257-harness-ledger.md']).code, 1);
    assert.equal(run('develop_base', ['docs/bug-report/some/bug-report.md']).code, 1);
  });

  it('review-notes/** → 拒绝（收窄移出）', () => {
    assert.equal(run('develop_base', ['review-notes/2026-07-19-review.md']).code, 1);
  });

  it('assets/** → 拒绝（收窄移出，含 markdown 知识文档和二进制）', () => {
    assert.equal(run('develop_base', ['assets/F257/objective-driven-redesign-v1.md']).code, 1);
    assert.equal(run('develop_base', ['assets/screenshots/foo.png']).code, 1);
  });

  it('混合 staged（白名单项 + 代码）→ 拒绝并只点名越界文件', () => {
    const { code, stderr } = run('develop_base', ['ROADMAP.md', 'packages/api/src/x.ts']);
    assert.equal(code, 1);
    assert.match(stderr, /packages\/api\/src\/x\.ts/);
    // ROADMAP.md should NOT appear in the "越界文件" violation list
    // (it may appear in the help text whitelist listing — only check the violation section)
    const violationSection = stderr.split('越界文件')[1]?.split('\n\n')[0] ?? '';
    assert.doesNotMatch(violationSection, /ROADMAP\.md/, 'whitelisted file must not be listed as violation');
  });

  it('hook 自身与模板（.githooks/** / scripts/** / cat-template.json）→ 拒绝（改动必须走 PR）', () => {
    assert.equal(run('develop_base', ['cat-template.json']).code, 1);
    assert.equal(run('develop_base', ['.githooks/pre-commit']).code, 1);
    assert.equal(run('develop_base', ['scripts/check-develop-base-allowlist.sh']).code, 1);
  });

  it('上游 pack 文件仍拒绝（shared-rules.md / skill 文件走 PR 通道）', () => {
    assert.equal(run('develop_base', ['cat-cafe-skills/refs/shared-rules.md']).code, 1);
    assert.equal(run('develop_base', ['cat-cafe-skills/feat-lifecycle/SKILL.md']).code, 1);
  });

  it('穷举白名单路径全部放行（路径正确性而非文件存在性）', () => {
    // 白名单五项逐一验证放行——不依赖文件物理存在（worktree 是 feature 分支）
    const whitelistPaths = [
      'BACKLOG.md',
      'ROADMAP.md',
      'cat-config.json',
      'cat-cafe-skills/refs/shared-rules.local.md',
      'docs/BACKLOG.md',
    ];
    for (const file of whitelistPaths) {
      assert.equal(run('develop_base', [file]).code, 0, `${file} must pass the allowlist`);
    }
  });

  it('行为变更注记：docs/features 直改被拦，改走 PR 或 operator --no-verify', () => {
    // 8263d2381 形态（feat-doc 直改 develop_base）将被拦
    const repoRoot = resolve(import.meta.dirname, '..', '..', '..');
    const featDoc = 'docs/features/F257-harness-ledger.md';
    assert.ok(existsSync(resolve(repoRoot, featDoc)), `${featDoc} exists in repo (anchor)`);
    assert.equal(run('develop_base', [featDoc]).code, 1, 'feat-doc direct commit must be rejected');
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
