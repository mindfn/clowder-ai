---
feature_ids: [F150]
related_features: [F087, F110, F134, F099]
topics: [guidance, ux, mcp, frontend, security]
doc_kind: spec
created: 2026-03-27
---

# F150: Scene-Based Bidirectional Guidance Engine

> **Status**: in-progress (Phase A 已闭环，当前在做真相源刷新 + 下一场景规划) | **Owner**: 布偶猫/宪宪 | **Priority**: P1

## Why

Console 功能日益复杂，但入口简单，用户不知道从哪开始。复杂配置（如飞书对接）涉及跨系统操作，用户需要在多个平台间来回切换，容易迷失。

当前痛点：
- 用户不知道"添加新成员"需要先配认证
- 飞书/钉钉等外部系统的权限配置需要反复截图沟通
- 猫猫无法实时看到用户操作状态，只能靠用户描述和截图诊断问题

> 铲屎官原话："我们的目标是让我们自己只承载我们真真需要的配置和功能；剩下的通过引导式来承载。猫猫们可以实时观察到当前用户的操作状态和效果，如果失败也就知道哪里有问题。不需要用户自己反复截图来证明和说明自己做的咋样了。"

## What

### 核心架构（v2 — tag-based auto-advance engine）

```
data-guide-id tags → Flow YAML (guides/flows/) → Runtime API → Guide Engine (Frontend)
                                                                      ↕ Socket.io
                                                                  Cat (状态感知)
```

**设计原则**（CVO Phase A 反馈收敛）：
- 自动推进：用户与目标元素交互后引导自动前进，无手动 下一步/上一步/跳过
- HUD 极简：仅显示 tips + progress dots + "退出"
- 标签驱动：前端元素仅标注 `data-guide-id`，tips 来自 YAML flow 定义
- 运行时加载：flow 由 `GET /api/guide-flows/:guideId` 运行时获取，非构建时生成

### Phase A: Core Engine + 内部场景验证（✅ 已实现）

**OrchestrationStep schema**（前后端共享）：
```typescript
interface OrchestrationStep {
  id: string;
  target: string;       // data-guide-id value
  tips: string;         // 引导文案（来自 YAML）
  advance: 'click' | 'visible' | 'input' | 'confirm';
}
```

**元素标签系统**：页面关键控件加稳定 `data-guide-id`，命名空间式（如 `hub.trigger`、`cats.add-member`），语义而非位置。Target whitelist: `/^[a-zA-Z0-9._-]+$/`。

**Flow YAML**：`guides/flows/*.yaml` 编排场景流程，`guides/registry.yaml` 注册发现。

**Guide Engine（前端）**：
- 全屏遮罩 + 目标元素区域镂空（呼吸灯动效）+ 四面板 click shield（镂空区可穿透点击）
- rAF 循环跟踪目标元素位置（rect 比较优化）
- 自动推进：`useAutoAdvance` hook 监听 click/input/visible/confirm 事件
- `guide:confirm` CustomEvent 用于确认型步骤（如保存成功后触发）
- 终态守卫：`setPhase('complete')` 后不可被 rAF 覆写为 `locating`
- HUD：tips + progress dots + "退出"，位置自动计算避免遮挡
- Error boundary：Guide crash 不影响主应用

**完成回调（frontend → backend）**：
- 前端 `phase='complete'` 时自动调用 `POST /api/guide-actions/complete`
- 后端 `guideState: active → completed` + 发 `guide_complete` Socket.io 事件
- 猫猫收到事件即可感知用户已完成引导

**前端 API 端点**（userId-based auth）：
- `POST /api/guide-actions/start` — offered/awaiting_choice → active
- `POST /api/guide-actions/cancel` — → cancelled
- `POST /api/guide-actions/complete` — active → completed
- `GET /api/guide-flows/:guideId` — 运行时获取 flow 定义

**MCP 工具**（callback auth）：
- `resolve` — 根据用户意图匹配候选流程
- `start` — 启动引导 session
- `control` — next/back/skip/exit
- `update-guide-state` — 通用状态机更新

**CI 验证**：`scripts/gen-guide-catalog.mjs` 校验 v2 schema + target whitelist

**P0 验证场景**：添加新成员（4 步：open-hub → go-to-cats → click-add-member → edit-member-profile）

### Phase B: 双向可观测 + 平台内场景扩展

> **Scope 调整（KD-13）**：Phase B 聚焦平台内已有功能的引导，不做跨系统深度集成。外部平台（飞书/微信等）的配置流程后续按场景单独做配置页签，不纳入 Guide Engine。

**观测层**：Guide Engine 实时上报字段状态 + 用户行为 → 猫猫实时感知：
- `observe.fields`：监听字段变化，实时校验，sensitive 字段只上报 `{filled, valid}`
- `on_error: notify_cat`：校验失败通知猫
- `on_idle: {seconds}`：用户停滞超时通知猫
- MCP `guide_observe` 工具：猫猫主动查询当前引导状态
- 事件推送（非轮询）：field_changed / step_completed / user_idle / verification_failed

**场景扩展**：基于已有 Console 功能逐场景补充引导流程，复用 Phase A 骨架（data-guide-id + Flow YAML + advance mode + complete callback）。具体场景所需的额外步骤类型或信息补充，结合场景实际需求决定。

**视觉增强**：
- 猫眼观测指示灯：正确→眯眼绿勾，错误→圆眼警示，停滞→晃动求助

**CI 契约测试**：flow schema + tag 存在性 + 退出路径

**P0 验证场景**：基于已有 Console 功能的高价值场景（如 API Provider 配置、连接器配置等）

**跨系统引导（deferred）**：外部平台对接（飞书/微信/钉钉）的配置流程不走 Guide Engine 遮罩引导，改为独立配置页签 + 分步操作说明，按场景需求单独设计。

### 当前进展与阶段判断（2026-04-03）

| 维度 | 当前状态 | 说明 |
|------|---------|------|
| 核心引擎 | ✅ 完成 | tag-based runtime、YAML flow、前端遮罩/镂空、auto-advance、exit-only HUD 已跑通 |
| P0 内部场景 | ✅ 完成 | `add-member` 已收口为 4 步：`hub.trigger → cats.overview → cats.add-member → member-editor.profile(confirm)` |
| 完成态闭环 | ✅ 完成 | 用户保存成功后才触发 `guide:confirm`；前端 `complete` 会回写后端 `guideState=completed` 并广播 `guide_complete` |
| 双向可观测 | 🟡 部分完成 | 当前只有完成态回流；字段级 observe / idle / verifier 反馈仍未进入实现 |
| 跨系统引导 | 🔒 deferred | KD-13：外部平台配置改为独立页签，不纳入 Guide Engine |
| 当前阶段判断 | `Phase A done` | 基础流程已闭环，可开始基于同一骨架继续补“典型场景”；Phase B 尚未开工 |

这意味着：
- F150 现在已经具备“从建议引导 → 前端操作 → 保存成功 → 后端状态同步 → 猫猫可感知完成”的最小完整闭环。
- 后续继续补新场景时，优先复用现有 `data-guide-id + Flow YAML + advance mode + complete callback` 骨架，不再回到硬编码流程。
- 下一步应该并行推进两件事：补下一个高价值典型场景，以及冻结 Phase B 的 observe/verifier 契约，避免场景扩展后再返工。

### 触发与发现规范

三层触发机制：
1. **对话触发（主）**：用户问意图 → 猫查 catalog → 建议引导 → [🐾 带我去做] 卡片 → 启动
2. **主动发现**：系统检测到未完成配置 → 猫主动建议相关引导
3. **目录浏览**：Console "场景引导" 入口，按类别列出所有可用流程

### guide-authoring Skill

已创建 `cat-cafe-skills/guide-authoring/SKILL.md`，定义 7 步标准 SOP：
场景识别 → YAML 编排 → 标签标注 → 注册发现 → 资产准备 → CI 契约 → E2E 验证。

### 场景优先级（能力审计结果）

| 优先级 | 场景 | Console Tab | 复杂度 | 跨系统 |
|--------|------|------------|--------|--------|
| P0 | 添加成员 | cats → HubCatEditor | 极高 | 否 |
| ~~P0~~ deferred | 飞书对接 | 独立配置页签（不走 Guide Engine）| 高 | 是 |
| P1 | 配置 API Provider | provider-profiles | 高 | 否 |
| P1 | 添加连接器（通用） | connector config | 高 | 是 |
| P1 | 开启推送通知 | notify | 中 | 否 |
| P2 | 管理猫猫能力 | capabilities | 中 | 否 |
| P2 | 治理看板配置 | governance | 中 | 否 |

### 触发与发现（详细设计）

**Guide Registry**（`guides/registry.yaml`）：注册所有可用引导，含 keywords + 意图映射。
**MCP Tool**：`guide_resolve(intent, context)` → 关键词匹配 registry → 返回候选引导列表。
**Skill Manifest**：猫检测到配置意图（"怎么/如何/配置"）→ 自动查 registry → 问用户"要我带你走一遍吗？"。
**主动发现**：后端检测未完成配置状态 → 推送建议到聊天（复用现有 Socket.io 事件管道）。

## Acceptance Criteria

### Phase A（Core Engine）
- [x] AC-A1: 页面关键控件有稳定 `data-guide-id` 标签（覆盖"添加成员"流程 4 个元素）
- [x] AC-A2: Guide flow YAML 加载器 + CI schema 验证（v2 schema + target whitelist）
- [x] AC-A3: Guide Engine 前端组件：遮罩 + 高亮 + 自动推进（v2: 无手动导航，HUD 仅退出）
- [x] AC-A4: MCP resolve/start/control 工具 + 前端 action routes（start/cancel/complete）
- [x] AC-A5: "添加成员" 引导流程端到端可运行（含 confirm 步骤 + 保存成功回调）
- [x] AC-A6: 对话触发：猫建议引导 → InteractiveBlock → 用户确认 → 启动
- [x] AC-A7: 完成回调：前端 complete → 后端 guideState completed → Socket.io 通知猫猫

### Phase B（双向可观测 + 平台内场景扩展）
- [ ] AC-B1: observe 层实时上报字段状态和用户行为到猫（事件推送，非轮询）
- [ ] AC-B2: 猫可通过 MCP guide_observe 主动查询当前引导状态
- [ ] AC-B3: 基于已有 Console 功能扩展 2+ 个引导场景（如 API Provider 配置、连接器配置）
- [ ] AC-B4: 猫眼观测指示灯（正确/错误/停滞视觉反馈）
- [ ] AC-B5: ~~飞书对接 E2E~~ → deferred（KD-13：外部平台配置改为独立页签，不走 Guide Engine）
- [ ] AC-B6: CI 契约测试通过（flow schema + tag + 退出路径）

### 安全门禁（跨 Phase，P0 硬性）
- [ ] AC-S1: Sensitive Data Containment — sensitive 值仅服务端持有（TTL + thread/user 绑定），前端只拿 secretRef，刷新后强制重填，observe 不上报长度/前缀，TTL 到期后 secretRef 失效 + 服务端 secrets 清理
- [ ] AC-S2: Verifier Permission Boundary — 只允许 verifierId 引用，sideEffect=true 必须 confirm:required，带 thread/user scope guard + timeout 熔断 + rate-limit 限流
- [ ] AC-S3: CI Contract Gate — flow schema 合法性 + tag 存在性 + auto_fill_from 校验 + verifier 注册校验 + skip_if 限声明式 DSL + 退出路径

## AC-S1/S2/S3 测试矩阵（草案）

> 目标：把安全门禁从“声明”变成“可执行验证”。
> 执行节奏：PR 内必须过 Unit + Integration；Phase Gate 过 E2E + Security。

### AC-S1: Sensitive Data Containment

| Test ID | 层级 | 场景 | 期望结果 | 证据 |
|---|---|---|---|---|
| S1-U1 | Unit | `collect_input(sensitive=true)` 序列化 guide state | 输出仅含 `secretRef`，无明文/可逆摘要 | 测试断言 + snapshot |
| S1-U2 | Unit | `guide_observe` 输出敏感字段 | 仅 `{ filled, valid }`，不含 value/length/prefix | 测试断言 |
| S1-I1 | Integration | 完整 collect → observe → event push 链路 | HTTP/WS payload 均无敏感值 | 抓包日志（脱敏） |
| S1-I2 | Integration | 页面刷新后恢复 guide session | sensitive 字段状态为 `needs_reentry=true` | API 响应断言 |
| S1-E1 | E2E | 飞书场景输入 secret 后切步 | HUD 显示已收集，回查历史消息/日志无 secret | E2E 断言 + trace JSONL（录屏补充） |
| S1-I3 | Integration | TTL 到期后访问 secretRef | secretRef 返回 `expired`，服务端 secrets 已清理 | API 断言 + DB 查询 |
| S1-Sec1 | Security | 伪造 `guide_observe` 请求读取他人 session | 403 + `guide_session_access_denied`，不泄露字段存在性 | 安全测试 JSONL |
| S1-Sec2 | Security | TTL 过期后探测 secretRef 残留 | 403 + 无信息泄露（不区分"过期"与"不存在"） | 安全测试 JSONL |

### AC-S2: Verifier Permission Boundary

| Test ID | 层级 | 场景 | 期望结果 | 证据 |
|---|---|---|---|---|
| S2-U1 | Unit | YAML verification 直写 URL/Method | 编排校验失败 | schema 测试断言 |
| S2-U2 | Unit | `sideEffect=true` + `confirm=auto` | 编排校验失败（强制 required） | 规则测试断言 |
| S2-I1 | Integration | `verifierId` 不存在 | 400 + 明确错误码 `verifier_not_found` | API 断言 |
| S2-I2 | Integration | 跨 thread/user 执行 verifier | 403（scope guard 生效） | API 断言 |
| S2-I3 | Integration | sideEffect verifier 未确认直接执行 | 409 + `verifier_confirmation_required` | API 断言 |
| S2-I4 | Integration | 同一确认 token 重放 | 幂等拒绝或去重，不重复副作用 | 审计日志对比 |
| S2-I5 | Integration | verifier 执行超过注册 timeout | 熔断返回 `verifier_timeout`，不阻塞引导流程 | API 断言 + 耗时日志 |
| S2-I6 | Integration | 同一 verifier 短时间内超过 rateLimit | 429 + `verifier_rate_limited` | API 断言 |
| S2-I7 | Integration | rate-limit 后自动退避重试 | 退避间隔符合注册配置，最终恢复或报错 | 时序日志断言 |
| S2-E1 | E2E | verification 失败 | HUD 展示基于 `verifierId + errorCode` 的自检清单 | E2E 断言 + 截图补充 |

### AC-S3: CI Contract Gate

| Test ID | 层级 | 场景 | 期望结果 | 证据 |
|---|---|---|---|---|
| S3-CI1 | CI-Static | Flow schema 校验（step 类型/字段） | 非法 flow 阻塞合并 | CI 日志 |
| S3-CI2 | CI-Static | Step graph 校验（无死链/环路/孤儿） | 非法 graph 阻塞合并 | CI 日志 |
| S3-CI3 | CI-Static | flow target 与 `data-guide-id` manifest 对照 | 缺失/重命名标签阻塞合并 | CI 日志 |
| S3-CI4 | CI-Static | `auto_fill_from` source/sink 类型与敏感级别校验 | 越权映射阻塞合并 | CI 日志 |
| S3-CI5 | CI-Static | verifier registry 存在性 + `sideEffect->confirm` 规则 | 违规阻塞合并 | CI 日志 |
| S3-CI6 | CI-Static | `skip_if` DSL 语法与操作符白名单 | 非声明式表达式阻塞合并 | CI 日志 |
| S3-CI7 | CI-Static | flow 退出路径校验（skip/cancel） | 无退出路径阻塞合并 | CI 日志 |
| S3-E2E-A1 | CI-E2E | P0 场景回归：添加成员（纯内部） | 主路径可完成，关键状态可回放 | E2E junit XML |
| ~~S3-E2E-B1~~ | ~~CI-E2E~~ | ~~飞书对接（跨系统）~~ | deferred（KD-13） | — |

### 质量门禁映射（建议）

- PR Gate（必须）：S1-U1/U2、S2-U1/U2、S3-CI1~CI7
- Phase A Gate（必须）：S1-I1/I2/I3、S2-I1/I2/I5/I6、S3-E2E-A1
- Phase B Gate（必须）：S1-E1、S1-Sec1/Sec2、S2-I3/I4/I7、S2-E1

### 证据归档格式（建议）

- 测试报告：`docs/review-notes/F150-security-gate-YYYY-MM-DD.md`
- 每条失败用例记录：`Test ID / 失败现象 / 根因 / 修复 commit`
- Quality Gate 结论必须逐条引用 S1/S2/S3 Test ID，不接受“整体通过”口头结论

## Dependencies

- **Related**: F087（猫猫训练营 — 类似的引导概念，但面向不同场景）
- **Related**: F110（训练营愿景引导增强 — 引导 UX 模式可复用）
- **Related**: F134（飞书群聊 — 飞书对接是 P0 验证场景之一）
- **Related**: F099（Hub 导航可扩展 — Hub tab/深链基础设施）

## Risk

| 风险 | 缓解 |
|------|------|
| 元素标签被 UI 重构意外删除/重命名 | CI 契约测试（AC-S3）阻塞合并 |
| 跨系统流程用户中途放弃导致状态不一致 | sessionStorage 持久化 + 猫猫感知 idle 超时 |
| collect_input 敏感值泄露 | AC-S1 封存规则 + 服务端 TTL |
| 流程文档与页面演进脱节 | CI gate 每次构建校验 tag manifest |
| Guide Engine 性能影响正常操作 | 遮罩层 z-index 隔离 + 不影响非引导区域交互 |

## Open Questions

| # | 问题 | 状态 |
|---|------|------|
| OQ-1 | Guide Engine 是否需要支持流程嵌套（一个 flow 调用另一个 flow 作为子步骤）？ | ⬜ 未定（建议 Phase B 后评估） |
| OQ-2 | 主动发现的触发条件如何定义？由前端检测还是后端推送？ | ⬜ 未定 |
| OQ-3 | guide-authoring skill 是否需要自动从录屏生成初始 flow YAML？ | ⬜ 未定 |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 选择"标签 + YAML 编排 + Guide Runtime"方案，否决硬编码和纯动态方案 | 可测、可审计、可版本化；新场景不改代码 | 2026-03-27 |
| KD-2 | 双向可观测：猫猫实时感知用户操作状态 | 免截图诊断；猫猫能主动介入卡点 | 2026-03-27 |
| KD-3 | sensitive 值刷新后不恢复，强制重填 | 安全优先于便利 | 2026-03-27 |
| KD-4 | 有副作用的 verification 按 verifier 配置 confirm: required/auto | sideEffect=true 必须二次确认，CI 校验规则 | 2026-03-27 |
| KD-5 | P0 skip_if 限声明式比较（eq/in/exists/gt/lt），禁止表达式 | 沙箱成本高，声明式可满足 P0 需求 | 2026-03-27 |
| KD-6 | observe.fields 对 sensitive 字段只上报 {filled, valid} | 防止侧信道泄漏长度/前缀 | 2026-03-27 |
| KD-7 | 迭代策略：核心引擎先完整 → P0(1内部+1外部)验收 → 再逐场景补全 | 不一次性实现所有场景；编排文件按需补充 | 2026-03-27 |
| KD-8 | external_instruction 支持富内容（多图 + 链接 + 前置条件 + 版本要求） | 胶囊 HUD 不够，外部步骤需要完整的操作指引卡片 | 2026-03-27 |
| KD-9 | v2 重构：自动推进取代手动导航，HUD 仅保留"退出" | CVO Phase A 反馈：手动导航降低体验，用户操作即推进 | 2026-03-30 |
| KD-10 | v2 步骤类型收敛为 4 种 advance mode（click/visible/input/confirm） | 简化 Phase A 范围，6 种步骤类型推迟到 Phase B 按需扩展 | 2026-03-30 |
| KD-11 | Flow YAML 运行时加载（API），不在构建时生成 TS | 解耦部署：改 flow 不需要重新构建前端 | 2026-03-30 |
| KD-12 | 完成回调作为基础能力：前端 complete → 后端状态 + Socket 通知 | CVO 明确要求：完整流程闭环是基础能力，不是后续补充 | 2026-04-03 |
| KD-13 | Phase B 聚焦平台内引导，外部平台配置改为独立页签（不走 Guide Engine） | CVO：跨系统对接方式可能变化（扫码等），引导引擎聚焦已有功能；外部流程按场景单独做页签 | 2026-04-06 |

## Timeline

| 日期 | 事件 |
|------|------|
| 2026-03-27 | 三猫讨论收敛 + 立项 |
| 2026-03-30 | v2 tag-based auto-advance engine 跑通，HUD 收敛为 exit-only，flow 改为运行时加载 |
| 2026-03-31 | P0 场景 add-member 4 步端到端验证通过 |
| 2026-04-01 | `add-member` 第 4 步收敛为 `confirm` 型步骤，保存成功后才允许完成 |
| 2026-04-03 | guide completion callback 打通：前端 complete → 后端 `guideState=completed` → Socket `guide_complete` |
| 2026-04-06 | CVO 方向校准：Phase B 聚焦平台内引导，跨系统配置改为独立页签（KD-13） |

## Review Gate

- Phase A: 砚砚(gpt52) 负责安全边界 + 可测性 review
- Phase B: 砚砚(gpt52) 安全 review + 烁烁(gemini25) 视觉 review

## Links

| 类型 | 路径 | 说明 |
|------|------|------|
| **Discussion** | `docs/discussions/2026-03-27-F150-guidance-engine-convergence.md` | 三猫讨论收敛纪要 |
| **Scene Catalog** | `docs/features/F150-scene-catalog.md` | 全量引导场景清单（12 场景，含步骤概要） |
| **Skill** | `cat-cafe-skills/guide-authoring/SKILL.md` | 引导流程设计 SOP |
| **Feature** | `docs/features/F087-bootcamp.md` | 类似引导概念（训练营） |
| **Feature** | `docs/features/F134-feishu-group-chat.md` | 飞书对接（P0 验证场景） |
| **Feature** | `docs/features/F137-weixin-personal-gateway.md` | 微信对接（P1 验证场景） |
