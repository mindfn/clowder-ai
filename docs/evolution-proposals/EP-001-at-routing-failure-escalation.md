---
ep_id: EP-001
title: "@ routing failure must trigger immediate escalation"
trigger_date: 2026-07-14
status: proposed
affects: all-cats
lever: shared-rules
author: opus
---

# EP-001: @ routing failure must trigger immediate escalation

## Trigger

Two deviations in F257 Phase D review cycle (2026-07-14):

1. `post_message(@codex)` returned `routed: []` / "未新增唤醒" — opus chose to wait instead of escalating. Wasted ~2 hours.
2. When recording this lesson, opus bypassed Cat Cafe's harness/memory system and wrote directly to Claude Code's file memory — evidence that our own self-improvement infrastructure isn't the first reflex.

## Evidence (≥2 sources)

1. **This incident**: terra session sealed (420s timeout), services not restarted, `@codex` routing returned `routed: []`. Opus said "等 terra 下次被调度时会看到我的 @ 消息" — false assumption, no auto-dispatch mechanism exists.

2. **F086 known pain point**: "A2A 经常断线，猫猫间协作不流畅，断了就需要operator手动重新调度" — the same pattern documented as a systemic issue in Cat Orchestration feature.

3. **Co-creator correction**: "它已经超时了 而且我们服务都重启了；没有任何人触发的情况下；他就不会被唤起吧；我们现在没有这个机制吧；为什么你认为我们可以继续等"

## Root Cause

1. **shared-rules §4 gap**: Transmission rules define three options (@ cat / hold_ball / @co-creator) but have no "@ failed" fallback clause. When routing returns failure, there's no prescribed behavior.

2. **hold_ball gotcha misleads**: "another cat sending a message re-invokes you" implies @ always results in a response — doesn't qualify with "only if the cat is currently schedulable."

3. **Ragdoll inference pattern**: Optimistic assumption ("they'll come back") substituted for mechanism verification ("does an auto-dispatch exist?"). Same family pattern as "我能猜出来" magic word.

4. **Harness reflex gap**: When a real learning event occurred, the natural action was to write a text file instead of using Cat Cafe's structured knowledge system — the harness is built but not reflexive.

## Lever (minimal)

**shared-rules §4 addition** (affects all cats, one-line rule):

> **@ 投递失败反射**：`post_message` 返回 `routed: []` 或 "未新增唤醒" = 目标猫不可调度。**禁止等待**——立即三选一：(1) 换另一只可用的猫 (2) @co-creator 请求手动 dispatch (3) 自己先推进能做的部分。"等它回来"不是选项。

Secondary lever: self-evolution skill should be the FIRST reflex for recording deviations, not Claude Code file memory.

## Verify

- **30-day check**: Next time any cat gets `routed: []`, do they immediately escalate? Search thread history for "未新增唤醒" occurrences and verify response pattern.
- **Success criteria**: Zero instances of "等 X 回来" after routing failure.
