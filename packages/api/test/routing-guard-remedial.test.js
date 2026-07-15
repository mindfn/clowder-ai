/**
 * F177 Phase H — server-side routing guard remedial 判据（路径 B）.
 *
 * 只测纯判据函数；实际 inline remedial invoke 走 route-serial 集成路径。
 * 原则（KD-8 safe）：只看"有无机械出口信号"，零意图分类器。
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  buildActionLivenessRemedialPrompt,
  buildRemedialPrompt,
  hasActionOrRoutingExit,
  hasValidRoutingExit,
  shouldRemediateActionLiveness,
  shouldRemediateRouting,
} from '../dist/domains/cats/services/agents/routing/guards/routing-guard-remedial.js';

const base = {
  lineStartMentions: [],
  toolNames: [],
  structuredTargetCats: [],
  hasCoCreatorLineStartMention: false,
};

describe('F177 Phase H — shouldRemediateRouting', () => {
  test('codex 无任何出口 + needsGuard + 未补救 → 触发 remedial', () => {
    assert.equal(shouldRemediateRouting({ ...base, needsGuard: true, attempted: false }), true);
  });

  test('非 guard 猫（Claude 系，已有 Stop hook）无出口 → 不触发', () => {
    assert.equal(shouldRemediateRouting({ ...base, needsGuard: false, attempted: false }), false);
  });

  test('one-shot guard：已补救过 → 不再触发（防 codex 烧猫粮）', () => {
    assert.equal(shouldRemediateRouting({ ...base, needsGuard: true, attempted: true }), false);
  });

  test('有行首 @ 传球 → 不触发', () => {
    assert.equal(
      shouldRemediateRouting({ ...base, lineStartMentions: ['opus48'], needsGuard: true, attempted: false }),
      false,
    );
  });

  test('有 hold_ball 工具 → 不触发', () => {
    assert.equal(
      shouldRemediateRouting({ ...base, toolNames: ['cat_cafe_hold_ball'], needsGuard: true, attempted: false }),
      false,
    );
  });

  test('有 multi_mention 工具 → 不触发', () => {
    assert.equal(
      shouldRemediateRouting({ ...base, toolNames: ['cat_cafe_multi_mention'], needsGuard: true, attempted: false }),
      false,
    );
  });

  test('有 structuredTargetCats（cross_post）→ 不触发', () => {
    assert.equal(
      shouldRemediateRouting({ ...base, structuredTargetCats: ['opus48'], needsGuard: true, attempted: false }),
      false,
    );
  });

  test('有 co-creator @co-creator 升级 → 不触发', () => {
    assert.equal(
      shouldRemediateRouting({ ...base, hasCoCreatorLineStartMention: true, needsGuard: true, attempted: false }),
      false,
    );
  });

  test('fake-hold（说持球但无 hold_ball 工具、无其他出口）→ 触发 [gpt52 主 failure]', () => {
    // 判据只看"有无出口"，不看"持球"文本。说了持球却没调 hold_ball = 无出口 = 该补救。
    assert.equal(
      shouldRemediateRouting({ ...base, toolNames: ['cat_cafe_search_evidence'], needsGuard: true, attempted: false }),
      true,
    );
  });
});

describe('F177 Phase H — hasValidRoutingExit', () => {
  test('无任何信号 → false', () => {
    assert.equal(hasValidRoutingExit(base), false);
  });
  test('行首 @ / hold_ball / multi_mention / targetCats / co-creator 任一 → true', () => {
    assert.equal(hasValidRoutingExit({ ...base, lineStartMentions: ['x'] }), true);
    assert.equal(hasValidRoutingExit({ ...base, toolNames: ['mcp__cat-cafe__cat_cafe_hold_ball'] }), true);
    assert.equal(hasValidRoutingExit({ ...base, toolNames: ['cat_cafe_multi_mention'] }), true);
    assert.equal(hasValidRoutingExit({ ...base, structuredTargetCats: ['x'] }), true);
    assert.equal(hasValidRoutingExit({ ...base, hasCoCreatorLineStartMention: true }), true);
  });
});

describe('F177 Phase H — buildRemedialPrompt', () => {
  test('含路由指引（行首 @ / hold_ball / @co-creator）且明确不重做工作', () => {
    const p = buildRemedialPrompt();
    assert.match(p, /行首/);
    assert.match(p, /hold_ball/);
    assert.match(p, /@co-creator/);
    assert.match(p, /不要重做/);
  });

  // F167 Phase P fix: remedial prompt must steer "等人" to @co-creator/@句柄, NOT hold_ball.
  test('等co-creator/等猫回复 明确指向 @co-creator/@句柄 而非 hold_ball（Phase P 双触发修复）', () => {
    const p = buildRemedialPrompt();
    assert.match(p, /等co-creator/);
    // 等人 bullet explicitly tells the cat NOT to hold_ball
    assert.match(p, /等co-creator[^\n]*不要 hold_ball/);
    // hold_ball option is scoped to 无回调 external conditions (not 等人)
    assert.match(p, /无回调/);
  });
});

describe('F257 LI-001 — action liveness completion guard', () => {
  const completionBase = {
    ...base,
    completionRequirement: 'action-or-routing-exit',
    attempted: false,
    hadError: false,
    aborted: false,
  };

  test('empty or text-only successful completion requires one remedial invoke', () => {
    assert.equal(shouldRemediateActionLiveness(completionBase), true);
  });

  test('any real tool call satisfies the action side even when it is not a routing tool', () => {
    assert.equal(hasActionOrRoutingExit({ ...base, toolNames: ['cat_cafe_search_evidence'] }), true);
    assert.equal(shouldRemediateActionLiveness({ ...completionBase, toolNames: ['cat_cafe_search_evidence'] }), false);
  });

  test('each existing mechanical routing exit satisfies the routing side', () => {
    assert.equal(hasActionOrRoutingExit({ ...base, lineStartMentions: ['opus'] }), true);
    assert.equal(hasActionOrRoutingExit({ ...base, toolNames: ['cat_cafe_hold_ball'] }), true);
    assert.equal(hasActionOrRoutingExit({ ...base, structuredTargetCats: ['opus'] }), true);
    assert.equal(hasActionOrRoutingExit({ ...base, hasCoCreatorLineStartMention: true }), true);
  });

  test('ordinary invocations, provider errors, aborts, and spent budget never trigger this guard', () => {
    assert.equal(shouldRemediateActionLiveness({ ...completionBase, completionRequirement: undefined }), false);
    assert.equal(shouldRemediateActionLiveness({ ...completionBase, hadError: true }), false);
    assert.equal(shouldRemediateActionLiveness({ ...completionBase, aborted: true }), false);
    assert.equal(shouldRemediateActionLiveness({ ...completionBase, attempted: true }), false);
  });

  test('remedial prompt requires a concrete action or explicit route and rejects text-only acknowledgement', () => {
    const prompt = buildActionLivenessRemedialPrompt();
    assert.match(prompt, /动作活性守卫/);
    assert.match(prompt, /工具/);
    assert.match(prompt, /行首/);
    assert.match(prompt, /纯文本|只回复文字/);
  });
});
