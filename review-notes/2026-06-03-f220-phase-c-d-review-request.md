# Review Request: F220 Phase C+D — PR Tracking Enhancement + Issue Tracking

Review-Target-ID: f220
Branch: feat/f220-plugin-schedule-resource

## What

Two independent enhancements to the GitHub plugin schedule system:

**Phase C — PR Tracking Enhancement** (commit `4b82511a`):
- `register_pr_tracking` now accepts `instructions` parameter, stored in `automationState.trackingInstructions`
- Review-feedback and CI/CD trigger messages append `trackingInstructions` as `Tracking Instructions` section
- New `cat_cafe_unregister_tracking` MCP tool: unregister any tracking task by subjectKey
- Security boundary: GitHub comment/review bodies wrapped in `[UNTRUSTED EXTERNAL CONTENT]` markers

**Phase D — Issue Tracking** (commits `52f982aa` + fixes):
- `issue_tracking` added to `TaskKind` union with eviction protection (parallel to `pr_tracking`)
- `IssueCommentRouter` + `IssueCommentTaskSpec`: poller that scans `issue_tracking` tasks, fetches new comments via cursor, routes to thread with `[UNTRUSTED EXTERNAL CONTENT]` wrapping
- `IssueAutomationState` nested under `AutomationState.issue` for cursor persistence
- `cat_cafe_register_issue_tracking` MCP tool + `/api/callbacks/register-issue-tracking` endpoint
- `github.issue-tracking` schedule factory registered in plugin manifest (5th resource)
- Auto-close: issue closed -> task marked done (AC-D4)
- Frontend: `issue` category label/style in schedule panel
- `MCP_TOOLS_SECTION` updated with both new tools (quality-gate catch)

## Why

Phase C enables cats to carry user intent through the tracking lifecycle — `instructions` tells the cat what to do when events fire (e.g., "Fix CI then merge"), and `unregister_tracking` gives cats explicit control to stop tracking.

Phase D extends the proven PR tracking pattern to GitHub issues — same architecture (global poller + per-thread routing), same security model (`[UNTRUSTED EXTERNAL CONTENT]`), same eviction protection.

## Original Requirements

> "触发的逻辑我理解应该是按照定时任务按照正常的定时任务的流程和逻辑执行然后来触发的"
> — F220 spec, CVO discussion

> Phase C: instructions 参数 / unregister_tracking / 安全边界
> Phase D: issue_tracking kind / issue comment poller / register_issue_tracking / auto-close
> — `docs/features/F220-github-plugin-schedule-resource.md` Phase C + D sections

- 来源: `docs/features/F220-github-plugin-schedule-resource.md`
- **请对照上面的摘录判断交付物是否解决了铲屎官的问题**

## Tradeoff

- Issue comment polling uses cursor-based dedup (same as PR review), not webhook — consistent with existing architecture (KD-1, KD-7)
- `unregister_tracking` is generic (works for both `pr:` and `issue:` subjectKeys) rather than two separate tools — DRY
- No custom polling intervals per issue — global poller only (rate limit concern, KD-1)

## Architecture Ownership

Architecture cell: transport (connector/poller domain)
Map delta: none
Why: Phase C/D extend existing TaskStore/poller/MCP patterns — `IssueCommentRouter` and `IssueCommentTaskSpec` are structurally identical to `ReviewFeedbackRouter`/`ReviewFeedbackTaskSpec`, within the same ownership cell

请 reviewer 检查:
- diff 是否与 `Map delta` 一致
- `IssueCommentRouter` / `IssueCommentTaskSpec` are new files but follow existing Router/TaskSpec pattern — not parallel architecture
- No new `Store` / `Queue` / `Dispatcher` / `Binding` created

## Open Questions

### 技术 OQ (给 reviewer)
1. `IssueCommentTaskSpec` cursor advancement uses `persistFirst` policy — reviewer please verify no edge case where comments could be double-delivered or lost
2. `fetchIssueState` is called per-task per-poll to detect closed issues — confirm this doesn't over-consume GitHub API rate limit compared to batch approach
3. `DisplayCategory` / `SubjectKind` / `sourceCategory` unions were extended in 6 files — reviewer please confirm no missing location

### 价值 OQ (给 CVO)
无

## Next Action

跨猫 review。请 @codex 审核 Phase C + D 实现的正确性和安全边界完整性。

## Review Sandbox

- Path: `/tmp/cat-cafe-review/f220/codex`
- Start Command: `pnpm review:start`
- Ports: reviewer 启动时自动分配隔离端口 (起点 3201/3202)

## 自检证据

### Spec 合规
Quality Gate Report 通过 — 8/8 AC 验收 (C1-C4, D1-D4)。
自查发现 1 个缺口 (MCP_TOOLS_SECTION 缺少新工具描述)，当轮修复 (`ac753092`)。

### 测试结果
```
F220 Phase C tests: 9/9 pass
F220 Phase D tests: 16/16 pass
Factory tests: 26/26 pass
Total F220 tests: 51 pass, 0 fail

pnpm check → 0 errors
pnpm lint → 0 errors
pnpm -r --if-present run build → exit 0
```

### 相关文档
- Plan: `feature-specs/2026-06-03-f220-phase-c-d.md`
- Feature: `docs/features/F220-github-plugin-schedule-resource.md`
- PR: #846
