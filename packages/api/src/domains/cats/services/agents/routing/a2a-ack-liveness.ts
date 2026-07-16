/**
 * F257 LI-005 Phase 1 — A2A Ack Liveness Detection (接球执行触发存活性检测).
 *
 * 检测猫通过 A2A 接到球后（inline @mention 或 queue-dispatched），invocation 结束时
 * 既无路由出口（行首 @mention / @co-creator / structured routing）也无持久触发器
 * （hold_ball / register_scheduled_task / register_pr_tracking /
 * register_issue_tracking / community_await_external），导致球静默死亡——
 * 无机制保证后续执行。
 *
 * Phase 1 scope: detection + hint + observability（ball.void_ack 事件 + telemetry）。
 * Phase 2（structural rejection / auto-wake）待 Phase 1 收集数据后实施。
 *
 * 声明-动作一致性检查的延伸：void-hold 查"说持球没做"，
 * ack-liveness 查"接了球没绑触发器"。
 *
 * 纯函数、零 IO、可测。
 *
 * @see void-hold-detect.ts — 同族守卫，模式参照
 * @see docs/features/assets/F257/live-candidates-2026-07-14.md — LI-005 定义
 */

/**
 * Tool names that constitute a "durable trigger" — calling any one of these
 * means the cat bound a mechanism that will ensure future execution.
 *
 * Criteria: the tool MUST register a system mechanism (timer, webhook, cron)
 * that will invoke the cat in the future. Pure bookkeeping tools (create_task)
 * do NOT qualify — they create visible panel items but have no invokeTrigger
 * or scheduled wake.
 *
 * Order doesn't matter (Set-based lookup). The list uses suffix matching
 * to cover both `mcp__cat-cafe-collab__cat_cafe_hold_ball` and
 * `cat_cafe_hold_ball` forms.
 *
 * TODO(LI-005 Phase 2): current check only verifies tool_use name presence,
 * not tool_result success. A 400/429/permission-denied tool call still
 * suppresses the hint. Fix: cross-reference with successful tool_result events.
 */
const DURABLE_TRIGGER_SUFFIXES: readonly string[] = [
  'cat_cafe_hold_ball',
  'cat_cafe_register_scheduled_task',
  'cat_cafe_register_pr_tracking',
  'cat_cafe_register_issue_tracking',
  'cat_cafe_community_await_external',
] as const;

function hasDurableTriggerToolCall(toolNames: readonly string[]): boolean {
  return toolNames.some((name) => DURABLE_TRIGGER_SUFFIXES.some((suffix) => name.endsWith(suffix)));
}

function hasRoutingExit(input: {
  lineStartMentions: readonly string[];
  structuredTargetCats: readonly string[];
  hasCoCreatorLineStartMention: boolean;
}): boolean {
  if (input.lineStartMentions.length > 0) return true;
  if (input.structuredTargetCats.length > 0) return true;
  if (input.hasCoCreatorLineStartMention) return true;
  return false;
}

export interface AckLivenessInput {
  /** True if this cat was invoked via A2A (@mention from another cat). */
  readonly isA2AInvocation: boolean;
  /** Tool names called during this invocation. */
  readonly toolNames: readonly string[];
  /** Line-start @mentions detected in the response text. */
  readonly lineStartMentions: readonly string[];
  /** Structured target cats from tool inputs (post_message / cross_post_message). */
  readonly structuredTargetCats: readonly string[];
  /** Whether the response text contains a co-creator line-start mention. */
  readonly hasCoCreatorLineStartMention: boolean;
}

export interface AckLivenessEvaluation {
  /** True iff the void-ack hint should fire. */
  readonly shouldEmit: boolean;
  /** True if the invocation had any routing exit (@ / structured routing). */
  readonly hasRoutingExit: boolean;
  /** True if the invocation called any durable trigger tool. */
  readonly hasDurableTrigger: boolean;
}

/**
 * Evaluate whether an A2A invocation ended without any durable trigger
 * or routing exit — the ball effectively dies.
 *
 * Only fires when ALL of:
 * 1. The cat was invoked via A2A (inline @mention or queue-dispatched)
 * 2. No routing exit exists (no @mention, no structured routing, no @co-creator)
 * 3. No durable trigger was bound (no hold_ball, register_scheduled_task, etc.)
 *
 * Non-A2A invocations (user-initiated) always return shouldEmit=false
 * because the user is watching and can re-invoke manually.
 */
export function evaluateAckLiveness(input: AckLivenessInput): AckLivenessEvaluation {
  if (!input.isA2AInvocation) {
    return { shouldEmit: false, hasRoutingExit: false, hasDurableTrigger: false };
  }

  const routing = hasRoutingExit(input);
  const trigger = hasDurableTriggerToolCall(input.toolNames);

  return {
    shouldEmit: !routing && !trigger,
    hasRoutingExit: routing,
    hasDurableTrigger: trigger,
  };
}
