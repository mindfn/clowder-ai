---
name: writing-plans
description: >
  将 spec/需求拆分为可执行的分步实施计划。
  Use when: 有 spec 或需求，准备动手前需要拆分步骤。
  Not for: trivial 改动（≤5 行）、已有详细计划。
  Output: 分步实施计划（含 TDD 步骤和检查点）。
triggers:
  - "写计划"
  - "implementation plan"
  - "拆分步骤"
---

# Writing Plans

## Overview

将 spec/需求拆分为分步实施计划。写清楚每步改哪些文件、代码、测试、怎么验证。DRY. YAGNI. TDD. Frequent commits.

**Announce at start:** "I'm using the writing-plans skill to create the implementation plan."

**Context:** Write the plan on main before opening a feature worktree. After the plan is committed, continue to `worktree` and then `tdd`.

**开工前 Recall（F102 记忆系统）🔴**：写计划前先搜相关历史——`search_evidence("{feature}")` 找相关 spec/ADR/讨论，避免重复造轮子。

**Save plans to:** `feature-specs/YYYY-MM-DD-<feature-name>.md`

## Truth-Source Model Gate（复杂需求强制）🔴

**写不出完整数据流 = 还没理解 = 不许拆步骤。**

对于涉及**跨层状态同步或级联更新**的需求（如：全局配置→项目配置→文件系统→UI 多层联动），动手拆步骤前**必须**先产出以下三张表。简单的 CRUD 读写（API 读 DB 返回 JSON）不触发此门禁：

### 表 1：真相源矩阵（谁写谁读谁派生）

```markdown
| 数据 | 真相源（写） | 消费方（读） | 派生关系 | 级联规则 |
|------|-------------|-------------|---------|---------|
| 例：全局 skill 启禁用 | capabilities.json (全局) | 项目级 capabilities / UI | 项目继承全局 | 全局禁用 → 所有项目 unmount |
```

**每一行必须回答**：这个数据从哪来？谁负责写？谁读？读的人直接读真相源还是读派生？状态变化时谁级联通知谁？

### 表 2：核心不变量（invariants）

```markdown
- INV-1: 全局禁用的 skill，任何项目下都不可见且无 symlink
- INV-2: 项目配置的启禁用状态 = 实际 symlink 存在与否
- INV-3: UI 展示的状态 = 后端 API 返回的状态（无前端 workaround）
```

**每条 invariant 必须可测试**——写不出对应的断言 = 不是 invariant，是愿望。

### 表 3：既有正确行为保护点

```markdown
| 现有功能 | 当前正确行为 | 保护方式 |
|---------|------------|---------|
| 项目选择器 | 能列出所有已知项目 | 现有测试 / 新增 regression guard |
```

**改代码前，先确认保护方式到位**（已有测试覆盖 or 需要先补测试）。没有保护 = 改了之后不知道有没有破坏。

### 何时豁免

- 单文件 ≤50 行改动、不涉及多数据源交互 → 可跳过
- 纯 UI 样式调整、文档修改 → 可跳过
- **涉及 config/state/filesystem 多层交互 → 不可跳过，写不出就停下来问清楚**

> **根因（2026-06-05 反思）**：布偶猫 F719 Skill Lifecycle Management 反复返工的核心病因是"边做边理解"——抓关键词就动手，没花时间画完整数据流。铲屎官给了闭环方案但实现出来"长得像但数据流不通"。此门禁把"理解"从"实现"中分离：理解产物是三张表，不是代码。

---

## Straight-Line Check (A→B, No Detour)

**Before splitting steps, do this first:**

1. **Pin the finish line**: one-sentence B definition + acceptance criteria + "what we're NOT building"
2. **Define terminal schema**: interfaces / types / data structures of the final form — steps are built around this, not throwaway scaffolding
3. **Every step passes three questions:**
   - Will this step's output stay in the final system as-is (extend only, no rewrite)? → Yes = on the line; No = detour
   - What can we demo/test after this step? (no verifiable evidence = detour)
   - If we remove this step, what specific cost does it add to reaching B? (can't articulate = detour)
4. **Pure exploration = explicit Spike** (time-boxed + output is a decision/conclusion, not a deliverable)

**Steps are internal implementation rhythm, NOT delivery batches.** The deliverable to the user is a complete feat matching the full spec — not a step's output. Do not expose intermediate steps as "验收点" to the user.

## Bite-Sized Task Granularity

**Each step is one action (2-5 minutes):**
- "Write the failing test" - step
- "Run it to make sure it fails" - step
- "Implement the minimal code to make the test pass" - step
- "Run the tests and make sure they pass" - step
- "Commit" - step

## Plan Document Header

**Every plan MUST start with this header:**

```markdown
# [Feature Name] Implementation Plan

**Feature:** F0xx — `docs/features/F0xx-xxx.md`
**Goal:** [One sentence — must match feat doc 的 goal]
**Acceptance Criteria:** [从 feat doc 逐条抄过来，plan 必须覆盖全部 AC]
**Architecture cell:** [ownership cell id from docs/architecture/ownership/README.md]
**Map delta:** none | update required | new cell required
**Map delta why:** [一句话说明为什么不改 map / 改哪个 cell / 为什么需要新 cell]
**Architecture:** [2-3 sentences about approach]
**Tech Stack:** [Key technologies/libraries]
**前端验证:** [涉及前端？标注 Yes — reviewer 必须用 Playwright/Chrome 实测]

---
```

**F191 约束**：普通增量写 `Map delta: none`，不得重新画架构图。`update required` 或 `new cell required` 代表 Phase 0 还包含 ownership map 更新，必须在 implementation steps 里列出来。

## Task Structure

```markdown
### Task N: [Component Name]

**Files:**
- Create: `exact/path/to/file.py`
- Modify: `exact/path/to/existing.py:123-145`
- Test: `tests/exact/path/to/test.py`

**Step 1: Write the failing test**

```python
def test_specific_behavior():
    result = function(input)
    assert result == expected
```

**Step 2: Run test to verify it fails**

Run: `pytest tests/path/test.py::test_name -v`
Expected: FAIL with "function not defined"

**Step 3: Write minimal implementation**

```python
def function(input):
    return expected
```

**Step 4: Run test to verify it passes**

Run: `pytest tests/path/test.py::test_name -v`
Expected: PASS

**Step 5: Commit**

```bash
git add tests/path/test.py src/path/file.py
git commit -m "feat: add specific feature"
```
```

## Open Questions in Plans

计划中的 Open Question 必须分类：
- **技术 OQ**：实现过程中自行解决
- **价值 OQ**：需要 CVO 判断 → 附 Decision Packet（格式见 `refs/decision-matrix.md`），包含 TL;DR + 回滚成本 + 真正需要判断的价值问题

先判断可逆性：回滚成本低的不升级 CVO，猫猫自决。

## Remember
- Exact file paths always
- Complete code in plan (not "add validation")
- Exact commands with expected output
- DRY, YAGNI, TDD, frequent commits

## 下一步

计划写完并提交 → **直接加载 `worktree`**（创建隔离开发环境）→ `tdd`（开始实现）。SOP 链条自动推进（§17）。
