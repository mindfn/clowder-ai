---
name: opensource-ops
description: >
  Portable workflow for operating on external GitHub PRs / issues from a Cat Café child thread.
  Use when: a thread is reviewing, triaging, intaking, or advising on a GitHub PR or issue in any repo.
  Not for: internal feature work with no external artifact, generic thread orchestration, or replacing the maintainer's own upstream decision.
  Output: grounded provider object + author/custody classification + adoption five-question answer + review/tracking/closure routed to the correct owner.
triggers:
  - "opensource-ops"
  - "社区 PR"
  - "external PR review"
  - "GitHub PR review"
  - "PR intake"
  - "issue triage"
---

# Open Source Ops — 外部 GitHub PR/issue 操作

> **SOP 位置**: 本 skill 是 `thread-orchestration` 在社区守门/外部 PR 场景下的子 workflow。
> **上一步**: `thread-orchestration`（分发） | **下一步**: `request-review` / `receive-review` / `merge-gate`

## 核心原则

1. **Server 不替你猜**：F128 proposal runtime 不再推断 PR identity、作者角色、主仓采纳策略或实例私有同步策略。这些判断必须在拥有 `cwd` / provider / provenance 上下文的 child-side 完成。
2. **Child thread 自己 grounding**：进入子 thread 后，第一只猫必须显式加载本 skill，用 `gh` / GitHub API / 本地 checkout 把外部对象落到可验证的事实。
3. **外部作者优先负责修复**：默认把 finding 路由给外部作者；家猫替作者改代码需要显式 Strategy B 授权与 provenance。
4. **反向溯源 fail-closed**：`proposal source`、`projectPath`、`preferredCats`、`initialMessage` 里的 URL 都不能直接当 origin 证据；必须有独立的 provider 级验证。

## 进入条件

在 child thread 中看到以下信号时加载本 skill：

- `title` / `reason` / `initialMessage` 出现 GitHub PR/issue URL 或 `owner/repo#NNN` 简写。
- 任务明确是 review / triage / intake / advisory 之一。
- 需要与外部 GitHub 作者、CI、 maintainer 交互。

## Step 1: Grounding（落地 provider object 与 author）

必须在动手判断之前完成：

```bash
# 1. 确认仓库、PR/issue 编号、当前 HEAD（PR）
gh pr view <NNN> --repo <owner/repo> --json number,headRefOid,author,state,title,body
gh issue view <NNN> --repo <owner/repo> --json number,author,state,title,body

# 2. 确认本地 worktree 与目标仓库关系
pwd
gh repo view --json owner,name,viewerAssociation
```

**必须产出的事实**：

| 字段 | 来源 | 说明 |
|------|------|------|
| `providerFullName` | `owner/repo` from URL or `gh` | 外部目标仓库全名 |
| `artifactNumber` | PR/issue number | 正整数 |
| `artifactKind` | `pr` / `issue` | PR 与 issue 的 custody 不同 |
| `authorLogin` | GitHub API `author.login` | 决定外部/内部作者 |
| `headSha` | PR HEAD（formal review 必需） | exact-HEAD review 的锚点 |
| `viewerRole` | `viewerAssociation` / 本地 fork 关系 | 判断我们是 maintainer / contributor / outsider |

**禁止**：从 thread title、proposal reason 或 `projectPath` 反推这些字段而不验证。

## Step 2: 作者 / 角色 /  custody 判断

角色只看 **作者是谁** 和 **我们与仓库的关系**，不看仓库名字：

| 场景 | 作者身份 | 我们角色 | custody 含义 |
|------|---------|---------|-------------|
| 外部贡献者向我们维护的仓库提 PR | 外部作者 | maintainer / core | 我们 review + merge；fix 默认回作者 |
| 我们向外部仓库提 PR | 我们自己 / 家猫 | contributor | 外部 maintainer review；我们修自己的 PR |
| 第三方仓库的 PR（纯审计） | 第三方 | outsider | advisory only；不写 verdict 到仓库 |
| issue / triage | 报告者 | 视仓库关系 | intake 或 advisory |

**Strategy B 例外**：只有当外部作者无响应、修复是 trivial blocker、且有 operator 或 maintainer 显式授权时，家猫才接管 fix。授权必须在 thread 中留下可引用的消息。

## Step 3: Maintainer 五问（仓库中立版）

把原来 zts212653/clowder-ai 专属的五问抽象成任何外部仓库都可以用的 adoption 框架：

1. **它对这个项目有益吗？** — 是否解决真实问题、符合项目方向、不引入反模式。
2. **它实际改了什么？** — 逐文件 diff summary、行为面变化、数据/安全/契约影响。
3. **值得 merge / adopt 吗？** — 与项目质量门禁、维护成本、semver 契约对齐。
4. **有更优雅的解法或架构切片吗？** — 是否可以用更小/更一致的改动达到同样目标。
5. **custody 边界在哪？** — 谁负责修、谁负责 merge、谁负责后续回归测试 / 文档 / 同步。

回答必须引用 grounding 步骤中的具体字段（`authorLogin`、`headSha`、`viewerRole` 等），不能只给主观结论。

## Step 4: 反向溯源（reverse provenance）

进入本 thread 的 proposal 可能带有一段 `initialMessage` 或 `reason`，里面提到外部对象。**这些信息只能算线索，不能算证据**：

| 来源类型 | 可信度 | 用法 |
|---------|--------|------|
| `verified origin` | 高 | `gh pr view` / `gh issue view` 返回的 `url`、`number`、`headRefOid` |
| `related` | 中 | thread title / reason 里提到的 PR/issue，但还没用 `gh` 验证 |
| `unknown` | 低 | 只有模糊描述，没有 `owner/repo#NNN` 或 URL |

**Fail-closed 规则**：
- 不能把 `proposal sourceMessageId`、`projectPath`、`preferredCats` 当 origin 证据。
- 不能把 "标题写了 clowder-ai#1387" 当已验证；必须跑一次 `gh` 拿到对象状态。
- 如果 grounding 失败（无网络、无权限、对象不存在），报告 `unknown` 并停止后续需要 provenance 的动作。

## Step 5: 工具落点与协作

### Review

- 用 `request-review` 把 diff 送给非作者猫做独立 review。
- Formal external review 必须写回同一 GitHub subject（`cat_cafe_record_external_review_verdict`）。
- Advisory / triage 可以只在本 thread 内产出 findings，不强制写 GitHub。

### Tracking

- **不要自动注册 PR tracking**。只有工作真实阻塞在外部条件（等作者回复、等 CI、等 maintainer review）时，才用 `cat_cafe_register_pr_tracking` / `cat_cafe_register_issue_tracking` 注册一个显式 typed predicate。
- 注册时必须写明 `when`、阻塞解除后的 `nextStep` 和 `expiresAt`。

### Merge / closure

- 外部 PR 的 merge 只能由有权限的 maintainer 账号执行；家猫共享 login 不能 self-review / self-merge。
- 合入后同步相关 feature doc / BACKLOG 到 `main`，按家规立即 commit + push。

## Step 6: 回报（reportingMode）

社区守门 / 外部 PR 分发使用 `reportingMode: "final-only"`：

- 闭环前 0 次过程 cross-post。
- 闭环后 1 次最终总结 cross-post 回主 thread，携带：
  - grounding 结果（`providerFullName`、`artifactNumber`、`headSha`）
  - 五问结论
  - custody 去向（作者修 / 家猫 Strategy B / advisory only）
  - 后续跟踪 registration（如果有）

## 与相关 Skill 的关系

| Skill | 层级 | 作用 |
|-------|------|------|
| `thread-orchestration` | 父 thread | 决定要不要开子 thread、选 projectPath、定 reportingMode |
| `opensource-ops`（本 skill） | 子 thread | 进入外部 PR/issue 上下文后的 grounding + 判断 + custody |
| `request-review` / `receive-review` | 子 thread | 代码级 review 循环 |
| `merge-gate` | 子 thread | 有权限时合入 / 同步状态 |
| `cross-cat-handoff` | 猫对猫 | 需要把 exact-HEAD review 交接给另一只猫 |

## Common Mistakes

| 错误 | 正确 |
|------|------|
| 从 title/reason 直接推 PR identity 而不 `gh view` | 先 grounding，再判断 |
| 把 `projectPath` 当成外部目标仓 | `projectPath` 是工作区归属；外部目标仓是独立的 provider object |
| 服务端应该自动注入五问 | 服务端不注入；子 thread 自己加载本 skill 执行 |
| 看到 PR 就自动注册 tracking | 只在真实阻塞时注册显式 typed predicate |
| 家猫直接替外部作者修 PR | 需要 Strategy B 授权 + provenance |
| 把 proposal source 当 origin 证据 | origin 必须来自 provider 级验证 |
