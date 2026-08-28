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

1. **Server 不替你猜**：F128 proposal runtime 不再推断 PR identity、作者角色、主仓采纳策略或任何实例私有同步策略。这些判断必须在拥有 `cwd` / provider / provenance 上下文的 child-side 完成。
2. **Child thread 自己 grounding**：进入子 thread 后，第一只猫必须显式加载本 skill，用 `gh` / GitHub API / 本地 checkout 把外部对象落到可验证的事实。
3. **外部作者优先负责修复**：默认把 finding 路由给外部作者；本地猫替作者改代码需要显式授权与 provenance。
4. **反向溯源 fail-closed**：`proposal source`、`projectPath`、`preferredCats`、`initialMessage` 里的 URL 都不能直接当 origin 证据；必须有独立的 provider 级验证与内部 provenance 搜索。

## 进入条件

在 child thread 中看到以下信号时加载本 skill：

- `title` / `reason` / `initialMessage` 出现 GitHub PR/issue URL 或 `owner/repo#NNN` 简写。
- 任务明确是 review / triage / intake / advisory 之一。
- 需要与外部 GitHub 作者、CI、maintainer 交互。

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

## Step 2: 身份与 custody 判断（fail-closed）

 custody 只看 **作者是谁** 和 **我们与仓库的关系**，不看仓库名字：

| 场景 | 作者身份 | 我们角色 | custody 含义 |
|------|---------|---------|-------------|
| 外部贡献者向我们维护的仓库提 PR | 外部作者 | maintainer / core | 我们 review + merge；fix 默认回作者 |
| 我们向外部仓库提 PR | 本地认证 identity | contributor | 外部 maintainer review；我们修自己的 PR |
| 第三方仓库的 PR（纯审计） | 第三方 | outsider | advisory only；不写 verdict 到仓库 |
| issue / triage | 报告者 | 视仓库关系 | intake 或 advisory |

**Fail-closed 分支**：

- `authorLogin` 是 bot / shared account / 无法解析 → 明确停住，标记 `author_kind: ambiguous`，不继续 custody 判断，直到 operator 或 maintainer 显式确认。
- 当前本地认证 identity 与 `authorLogin` 冲突 → 按 contributor（自己的 PR）处理，禁止以 maintainer 身份 self-review / self-merge。
- maintainer capability（merge 权限）必须与 authorship 分离：能 merge 不等于就是作者，是作者不等于能 merge。

**本地猫接管 fix 的授权**：只有当外部作者无响应、修复是 trivial blocker、且有 operator 或 maintainer 显式授权时，本地猫才接管 fix。授权必须在 thread 中留下可引用的消息，并记录 provenance。

## Step 3: Maintainer 五问（仓库中立版）

把原来 zts212653/clowder-ai 专属的五问抽象成任何外部仓库都可以用的 adoption 框架：

1. **问题与设计差距**：它解决什么问题？当前方案与项目现有设计/契约的差距在哪？
2. **Vision/contracts fit**：它是否符合项目方向、semver 契约、架构原则？是否引入反模式？
3. **是否 adopt**：基于前两条，给出 adopt / reject / advisory-only 的明确结论。
4. **Adopt 后的路径**：merge-as-is / redesign / reimplement / port — 哪一种是风险最小的终态？
5. **Custody 边界**：谁负责修、谁负责 review、谁负责 merge、谁负责后续回归测试 / 文档 / 同步？

回答必须引用 grounding 步骤中的具体字段（`authorLogin`、`headSha`、`viewerRole` 等），不能只给主观结论。

## Step 4: 反向溯源（reverse provenance）

进入本 thread 的 proposal 可能带有一段 `initialMessage` 或 `reason`，里面提到外部对象。**这些信息只能算线索，不能算证据**。

### 内部 provenance 搜索

用现有 project/thread evidence 能力验证这个 child thread 是从哪里来的：

1. 读取 child thread 的 `createdFromProposalId` / `sourceThreadId`。
2. 用 `cat_cafe_get_thread_context` 读取源 thread 的 proposal card 与源消息。
3. 用 `cat_cafe_search_evidence` 搜索源 thread 中是否有显式的 PR↔thread/commit/proposal anchor（例如 `pr:owner/repo#NNN`、commit SHA、proposalId）。
4. 只有在内部 thread 证据与 `gh pr view` 返回的 `url`/`number`/`headRefOid` 一致时，才能标记为 `verified origin`。

### 证据分级

| 来源类型 | 可信度 | 用法 |
|---------|--------|------|
| `verified origin` | 高 | 内部 thread 证据 + `gh` provider 验证双重确认 |
| `related` | 中 | 内部线索提到该 PR/issue，但缺少显式 anchor；必须逐项列出关系证据 |
| `unknown` | 低 | 只有模糊描述，没有 `owner/repo#NNN` 或 URL，或 grounding 失败 |

### Fail-closed 规则

- 不能把 `proposal sourceMessageId`、`projectPath`、`preferredCats` 当 origin 证据。
- 不能把 "标题写了 clowder-ai#1387" 当已验证；必须跑一次 `gh` 拿到对象状态，并用 `search_evidence` 找到内部 anchor。
- 如果 grounding 失败（无网络、无权限、对象不存在），报告 `unknown` 并停止后续需要 provenance 的动作。
- 内部 provenance 与外部对象对不上 → 输出 `unknown` 并升级到 operator。

### 记录 verified metadata

当 origin 被验证后，调用 `cat_cafe_set_thread_metadata` 把外部对象与当前 thread 关联起来：

```json
{
  "prs": [{ "repo": "owner/repo", "number": 123 }],
  "issues": [{ "repo": "owner/repo", "number": 456 }]
}
```

**Step 5 不得在没有 metadata write 的情况下继续** —— 只有写入了 verified PR metadata，后续 tracking/review/closure 才有可追溯的 anchor。

## Step 5: 工具落点与协作

### Review

- 用 `request-review` 把 diff 送给非作者猫做独立 review。
- Formal external review 必须写回同一 GitHub subject（`cat_cafe_record_external_review_verdict`）。
- Advisory / triage 可以只在本 thread 内产出 findings，不强制写 GitHub。

### Tracking

- **不要自动注册 PR tracking**。只有工作真实阻塞在外部条件（等作者回复、等 CI、等 maintainer review）时，才用 `cat_cafe_register_pr_tracking` / `cat_cafe_register_issue_tracking` 注册一个显式 typed predicate。
- 注册时必须写明 `when`、阻塞解除后的 `nextStep` 和 `expiresAt`。

### Merge / closure

- 外部 PR 的 merge 只能由有权限的 maintainer 账号执行；本地猫共享 login 不能 self-review / self-merge。
- 合入后是否需要同步 feature doc / BACKLOG 由项目自己的 SOP 决定，本 skill 不做实例私有假设。

## Step 6: 回报（reportingMode）

社区守门 / 外部 PR 分发使用 `reportingMode: "final-only"`：

- 闭环前 0 次过程 cross-post。
- 闭环后 1 次最终总结 cross-post 回主 thread，携带：
  - grounding 结果（`providerFullName`、`artifactNumber`、`headSha`）
  - 五问结论
  - custody 去向（作者修 / 本地猫显式授权接管 / advisory only）
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
| 本地猫直接替外部作者修 PR | 需要显式授权 + provenance |
| 把 proposal source 当 origin 证据 | origin 必须来自内部 provenance + provider 级验证 |
| 用 "家猫"/"家里" 描述 portable workflow | 本 skill 是仓库中立的；实例成员关系只在明确知道当前 deployment 时才使用 |
