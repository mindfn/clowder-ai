/**
 * F257 修复清单 #4 — message-signature structural lint (O2→O1).
 *
 * 真相源：docs/features/F257-harness-ledger.md L198 —「签名 lint O2→O1：消息末行
 * 签名 [昵称/模型🐾] 是完美可 lint 断言，当前零结构覆盖（dev-7a882ba0：靠 operator
 * 人工发现）」。本测试锁定 `lintCatSignature` 的结构化断言契约：agent 消息末行是否
 * 以一个被识别的猫签名结尾。
 *
 * 设计：presence-only（是否有 trailing 签名），非 identity-correctness（是否匹配发帖
 * 猫本身——那需要 per-cat nickname/model 解析，属 F257 #1 域，最小 O1 升级不含）。
 * 判定复用 `isCatSignatureLine`（F167 cat-signature-strip，多轮 FP 收敛真相源），本
 * 测试只验 walk 逻辑 + 代表性签名形态的端到端委托，不重测每一条 FP 边界（那是
 * cat-signature-strip 自身测试的职责）。
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  lintCatSignature,
  signatureLintExtra,
} from '../dist/domains/cats/services/agents/routing/cat-signature-lint.js';

describe('F257 #4 — lintCatSignature (O2→O1 message-signature structural lint)', () => {
  // --- 正例：末行是有效 trailing 签名（委托 isCatSignatureLine）---
  test('pawed slashed 签名在末行 → signed，返回 trimmed 签名行', () => {
    const r = lintCatSignature('Some review text.\n\n[宪宪/claude-opus-4-8🐾]');
    assert.equal(r.signed, true);
    assert.equal(r.signatureLine, '[宪宪/claude-opus-4-8🐾]');
  });

  test('pawed slashless 签名 [Spark🐾] → signed', () => {
    assert.equal(lintCatSignature('done\n\n[Spark🐾]').signed, true);
  });

  test('legacy 无爪 slashed 签名 [砚砚/GPT-5.5] → signed', () => {
    assert.equal(lintCatSignature('merged\n[砚砚/GPT-5.5]').signed, true);
  });

  test('整条消息就是一个签名 → signed', () => {
    assert.equal(lintCatSignature('[宪宪/claude-opus-4-8🐾]').signed, true);
  });

  // --- walk 逻辑：跳过 trailing 空行 / 行内空白 ---
  test('签名后有 trailing 空行 → 仍 signed（跳过空行）', () => {
    assert.equal(lintCatSignature('text\n[烁烁🐾]\n\n  \n').signed, true);
  });

  test('签名行含前后空白 → signed，signatureLine 已 trim', () => {
    const r = lintCatSignature('text\n   [宪宪/Opus-46🐾]   ');
    assert.equal(r.signed, true);
    assert.equal(r.signatureLine, '[宪宪/Opus-46🐾]');
  });

  test('\\r\\n 换行 → 正确 walk', () => {
    assert.equal(lintCatSignature('line1\r\nline2\r\n[砚砚/Codex🐾]\r\n').signed, true);
  });

  // --- 反例：签名非末尾（其后还有内容行）→ 不算（约定是签名为最后一行）---
  test('签名后还有内容行 → NOT signed（必须 trailing）', () => {
    const r = lintCatSignature('[宪宪🐾]\n\nPS: one more thing.');
    assert.equal(r.signed, false);
    assert.equal(r.signatureLine, null);
  });

  // --- 反例：完全没有签名（dev-7a882ba0 漏签类）---
  test('普通消息无签名 → not signed', () => {
    assert.equal(lintCatSignature('LGTM, merging now.').signed, false);
  });

  test('空串 → not signed', () => {
    const r = lintCatSignature('');
    assert.equal(r.signed, false);
    assert.equal(r.signatureLine, null);
  });

  test('纯空白 → not signed', () => {
    assert.equal(lintCatSignature('   \n\n  ').signed, false);
  });

  // --- 反例：FP 形态（复用 isCatSignatureLine 的两侧精确 allowlist 边界）---
  test('正文 token [Phase B] → not signed', () => {
    assert.equal(lintCatSignature('Update:\n[Phase B]').signed, false);
  });

  test('括号文件路径 [packages/api/src/foo.ts] → not signed', () => {
    assert.equal(lintCatSignature('see\n[packages/api/src/foo.ts]').signed, false);
  });

  test('provider/path LHS FP [openai/GPT-5.5] → not signed', () => {
    assert.equal(lintCatSignature('ref\n[openai/GPT-5.5]').signed, false);
  });

  test('CJK 语义标签 FP [模型/GPT-5.5] → not signed', () => {
    assert.equal(lintCatSignature('x\n[模型/GPT-5.5]').signed, false);
  });

  test('终端引用 [PR/2442] → not signed', () => {
    assert.equal(lintCatSignature('landed\n[PR/2442]').signed, false);
  });
});

describe('F257 #4 — signatureLintExtra (post-seam extra projection)', () => {
  test('signed message → { signatureLint: { signed: true } }', () => {
    assert.deepEqual(signatureLintExtra('done\n\n[宪宪/claude-opus-4-8🐾]'), {
      signatureLint: { signed: true },
    });
  });

  test('unsigned text message → { signatureLint: { signed: false } }', () => {
    assert.deepEqual(signatureLintExtra('LGTM, merging now.'), {
      signatureLint: { signed: false },
    });
  });

  test('blank/whitespace content → {} (pure-media exclusion, out of denominator)', () => {
    assert.deepEqual(signatureLintExtra(''), {});
    assert.deepEqual(signatureLintExtra('   \n\n  '), {});
  });
});
