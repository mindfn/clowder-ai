---
feature_ids: [F202]
topics: [plugin-framework, train-c1, assessment]
doc_kind: plan
created: 2026-09-21
architecture-cell: plugin
---

# F202 C1 — 诚实评估与最短可行路径

> 决策入口看本文。`2026-09-21-f202-c1-convergence-worklist.md`（1,055 行）是推导过程存档，
> **其中多处结论已被后续证据推翻，不要拿它做决策依据。**

## 一、唯一重要的那个事实

**`packages/api/src/domains/plugin` 有 18,254 行实现，至今没有任何一个插件能被激活。**

不是"差一点"——是 `module-plugin-runtime.ts:44` 自己写着 *"Loading is done here; activation is not."*
已装的唯一 `@clowder-ai/*` 插件（feishu-meeting-intake）是 stdio，根本不走 module 载体。

每一层都在加保证（完整性校验 / revision fence / 权限栅栏 / lease / 冻结 wire 表 / 双向校验），
**没有一层交付功能**。这就是 operator 说的"漂亮的空架子"，数字支持这个判断。

## 二、哪里退是合理的（逐条带证据）

### R-1 · 退掉 feature 这一维度 —— 强烈建议

**证据**：插件仓 14 个包，**每个恰好 1 个 feature**，`companion` 是 0。
**没有任何一个包用到多 feature。**

但 Host 与 SDK 为这一维度付出了全套代价：per-feature `FeatureContext`、per-feature
`activate`、per-feature action 表、per-feature `dispose`、`FeatureBinding` 里的
`featureId`/`activationRevision`/`grantRevision`、`context.featureId !== featureId` 校验……

VSCode 是**插件级** `activate(context)`，没有这一层。
**退到插件级激活，能删掉一整个维度的复杂度，而不损失任何已在使用的能力。**

> 反对意见需要回答：哪个真实插件需要"只启用一部分功能"？目前一个都没有。

### R-2 · 退掉（或降级）actions ↔ manifest 的严格双向校验 —— 建议

`activateDefinedFeature` 要求声明与实现一一对应：多一个报 `undeclared`，少一个报 `missing`。

**我先前说这"比 VSCode 更严所以更好"，这句没有论据，而且大概率是错的。**
正确论据是反向的：**这条校验换走了 lazy activation。**
VSCode 的 `activationEvents` 懒加载是它装 50 个插件还能秒开的原因；
要求 activate 时就产出全部声明的 handler，等于强制 eager、all-or-nothing。

**退法**：保留"不能暴露未声明的方法"（安全相关），去掉"声明了必须立刻实现"（换回懒加载）。

### R-3 · 不退：12 类 contribution

**我原本要建议砍到 4 类，证据不支持，收回。**
14 个包实际在用 **9 类**：identity · message-subscription · webhook · connector ·
content-editor-provider · schedule · mcp · limb · skill。只有 tool / service / ui 空着。

### R-4 · 退掉四套 yaml 里的重复

元数据 + 配置字段有 **3 套**解析（`plugin-manifest.ts` 351 行 / `im-connector-manifest.ts` /
`package-staging.ts` 234 行），字段名还不一样（`envName,label,sensitive,required`
vs `key,label,kind,required`）。`connector.yaml` 与 main `plugin.yaml` 几乎同形，先合这两套。

## 三、哪里不清楚（不要假装清楚）

1. **插件仓没有可信终态制品。** 工作区脏，`plugin-sdk/package.json` 有 2 处冲突标记，
   `wire-dispatch` 正从 sdk 搬向 contract（改到一半被暂停）。提交态 Telegram 调用了
   提交态 `FeatureContext` 里不存在的 `context.connectors.deliver`。
   → **现在不能升 Host 的 SDK pin，会把一个半成品钉死。**
2. **`GitHubOperationPort.run()` 由谁实现没有定论。** 写在 Host 违反
   "delete provider-specific Core implementations"；写在包里则 7 个 operation body 要先搬家。
3. **lazy activation 要不要**（见 R-2）。这是产品体验决策，不是实现细节。

## 四、怎么做：让"一个插件真的跑起来"的最短路径

前提：先定 R-1（feature 级 vs 插件级）。这一条不定，写什么都可能白写。

```
1. Host: enable 之后调用包的 activate，拿到 handler 表并存住；
         disable / 卸载 / 启动失败时确定性 dispose。
2. Host: module-host-invocation.ts:31 的方法名从写死常量改成查 handler 表。
3. 验收: 已恢复的声明式 RED（0f7c62983）转绿 —— 本地目录装包 → enable →
         skill 进 capabilities 且 owner 是 pluginId → disable → 消失。
4. 然后才谈 schedule / limb 白名单、yaml 合并、17,595 行删除。
```

**不要在第 3 步绿之前做第 4 步的任何一项。**
这个仓库已经证明：先加机制、后接功能，会得到 18,254 行不能用的代码。

## 五、给接手者：这份文档哪里不能信

写这份文档的是 opus，在同一个 session 里**连续给出并推翻了四个方向**
（不该造适配器 → 插件仓是总闸 → 删掉 C1 → 往 main 4 类收敛），
每次都是被最后说话的人纠正，而不是自己先验证。operator 已明确表示不再信任其判断。

**接手时请独立复核，尤其是：**

- 本文 R-1 的 feature 计数（`for f in packages/*/plugin.yaml` 数 `features:` 下的 `- id:`）
- 18,254 这个数字（`find packages/api/src/domains/plugin -name '*.ts' | xargs wc -l`）
- 第四节第 1、2 步是否真是最短路径 —— 这是本文唯一未被外部证据交叉验证的部分

**已被推翻、不要再引用的旧结论**：见 worklist §0.0–§0.05 各节自带的作废标记。
