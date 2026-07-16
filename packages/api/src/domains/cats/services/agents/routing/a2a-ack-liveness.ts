/**
 * F257 LI-005 — A2A Ack Liveness Detection (接球执行触发存活性检测).
 *
 * 检测猫通过 A2A @mention 接到球后，invocation 结束时既无路由出口
 * （行首 @mention / @co-creator / structured routing）也无持久触发器
 * （hold_ball / create_task / register_scheduled_task / register_pr_tracking
 * / register_issue_tracking），导致球静默死亡——无机制保证后续执行。
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
 * Order doesn't matter (Set-based lookup). The list uses suffix matching
 * to cover both `mcp__cat-cafe-collab__cat_cafe_hold_ball` and
 * `cat_cafe_hold_ball` forms.
 */
const DURABLE_TRIGGER_SUFFIXES: readonly string[] = [
  'cat_cafe_hold_ball',
  'cat_cafe_create_task',
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
 * 1. The cat was invoked via A2A (@mention from another cat)
 * 2. No routing exit exists (no @mention, no structured routing, no @co-creator)
 * 3. No durable trigger was bound (no hold_ball, create_task, etc.)
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
