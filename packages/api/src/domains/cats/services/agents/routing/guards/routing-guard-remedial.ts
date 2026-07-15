/**
 * F177 Phase H — Server-side routing guard remedial logic (路径 B).
 *
 * codex/gpt52 走 `codex exec --json`，吃不到 Claude Code 的 F177-G Stop hook
 * （H0 spike 实测 2026-06-11：`codex exec` 不 dispatch `~/.codex/hooks.json`）。
 * 本模块提供 server 层兜底判据：检测点判定"无合法路由出口"后，对带
 * `needsServerRoutingGuard` capability 的猫做一次 inline remedial invoke
 * （同 turn、同 session resume），逼它补出口。
 *
 * 纯判据在此（KD-13）；实际 re-invoke 在 route-serial 集成路径。
 * cost guard = 本 route iteration 本地 one-shot（routingGuardAttempted）。
 * KD-8 safe：只看"有无机械出口信号"，零意图分类器。
 */

import type { CompletionRequirement } from '../route-helpers.js';

/** Routing-tool substrings that count as a legitimate exit (持球/群发传球). */
const ROUTING_TOOL_SUBSTRINGS = ['hold_ball', 'multi_mention'] as const;

function hasRoutingToolCall(toolNames: readonly string[]): boolean {
  return toolNames.some((name) => {
    const lower = name.toLowerCase();
    return ROUTING_TOOL_SUBSTRINGS.some((sub) => lower.includes(sub));
  });
}

export interface RoutingExitInput {
  /** Line-start @cat mentions parsed this turn (parseA2AMentions). */
  readonly lineStartMentions: readonly string[];
  /** Tool names invoked this turn (scan for hold_ball / multi_mention). */
  readonly toolNames: readonly string[];
  /** Structured targetCats from cross_post / multi_mention tool input. */
  readonly structuredTargetCats: readonly string[];
  /** Line-start @co-creator / @co-creator escalation to co-creator. */
  readonly hasCoCreatorLineStartMention?: boolean;
}

/**
 * True iff the turn has a legitimate routing exit (传球 / 持球 / 升级).
 * Mirrors the suppression set of evaluateVoidHold + F177-G hook
 * (line-start @, hold_ball, multi_mention, targetCats, co-creator).
 */
export function hasValidRoutingExit(input: RoutingExitInput): boolean {
  if (input.lineStartMentions.length > 0) return true;
  if (input.structuredTargetCats.length > 0) return true;
  if (input.hasCoCreatorLineStartMention) return true;
  if (hasRoutingToolCall(input.toolNames)) return true;
  return false;
}

/** F257 LI-001: any tool action or an existing mechanical routing exit satisfies the wake-up contract. */
export function hasActionOrRoutingExit(input: RoutingExitInput): boolean {
  return input.toolNames.length > 0 || hasValidRoutingExit(input);
}

export interface ActionLivenessInput extends RoutingExitInput {
  readonly completionRequirement?: CompletionRequirement;
  /** Shared one-shot budget with the existing routing guard. */
  readonly attempted: boolean;
  readonly hadError: boolean;
  readonly aborted: boolean;
}

export function shouldRemediateActionLiveness(input: ActionLivenessInput): boolean {
  return (
    input.completionRequirement === 'action-or-routing-exit' &&
    !input.attempted &&
    !input.hadError &&
    !input.aborted &&
    !hasActionOrRoutingExit(input)
  );
}

export interface RemediateInput extends RoutingExitInput {
  /** service.needsServerRoutingGuard?.() — only codex-family is true (KD-13). */
  readonly needsGuard: boolean;
  /** local one-shot guard — true once a remedial invoke already ran this turn. */
  readonly attempted: boolean;
}

/**
 * Decide whether to fire an inline remedial invoke for a non-Claude cat that
 * ended its turn with no valid routing exit. One-shot: returns false once
 * `attempted`.
 *
 * fake-hold is covered without inspecting text: a 持球 claim with no hold_ball
 * tool call (and no other exit) simply has no valid exit → triggers. This is
 * gpt52's dominant failure mode (动作缺失型掉球).
 */
export function shouldRemediateRouting(input: RemediateInput): boolean {
  if (!input.needsGuard) return false;
  if (input.attempted) return false;
  return !hasValidRoutingExit(input);
}

/** Remedial prompt: ask for ONLY a routing action, never a rework. */
export const REMEDIAL_PROMPT =
  '[路由守卫] 你刚才的回复没有合法的路由出口（既没有行首 @句柄传球，也没有调用 cat_cafe_hold_ball 持球）。\n' +
  '请只补一个出口，不要重做刚才的工作：\n' +
  '- 传球：另起一行，行首独立写 @句柄（如 @opus48）\n' +
  '- 等co-creator / 等另一只猫回复 → 用 @co-creator / @句柄，不要 hold_ball：对方的消息会触发你，hold 定时器只是冗余的第二次触发\n' +
  '- 持球等**无回调**的外部条件（远端 CI / cloud verdict / webhook；本地长命令用 wakeWhen）：调用 cat_cafe_hold_ball\n' +
  '- 升级co-creator：另起一行行首写 @co-creator';

export function buildRemedialPrompt(): string {
  return REMEDIAL_PROMPT;
}

export const ACTION_LIVENESS_REMEDIAL_PROMPT =
  '[动作活性守卫] 这次持球唤醒只产生了空响应或纯文本承诺，没有形成可验证动作或明确路由终态。\n' +
  '现在只做一个具体收尾动作：\n' +
  '- 条件已满足且能继续 → 立即调用完成下一步所需的工具；\n' +
  '- 需要另一只猫或co-creator处理 → 用行首 @句柄 / @co-creator 明确传球；\n' +
  '- 仍需等待无回调外部条件 → 调用 cat_cafe_hold_ball；需要并行分派 → 调用 cat_cafe_multi_mention。\n' +
  '只回复文字、纯文本确认或承诺稍后处理都不算完成；不要复述刚才的内容。';

export function buildActionLivenessRemedialPrompt(): string {
  return ACTION_LIVENESS_REMEDIAL_PROMPT;
}
