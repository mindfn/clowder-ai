---
feature_ids: [F140]
related_features: [F087, F110, F127, F105, F115]
topics: [onboarding, first-run, gamification, installer, cat-template, roster]
doc_kind: spec
created: 2026-03-26
---

# F140: First-Run Quest — 首次安装零成员 + 游戏化新手引导

> **Status**: in-progress (Phase A-D complete, Phase E pending) | **Owner**: Maine Coon + Ragdoll | **Priority**: P1

## Why

当前首次安装仍是“预装团队即开即用”模型：安装阶段会触发认证配置，运行时默认就有完整成员 roster。这个路径与新目标冲突：

1. 安装完成后默认 `0 active members`
2. `cat-template.json` 作为角色模板库（灵魂层），不再等同于运行成员
3. 首次打开时走可跳过的新手任务流程：创建第一只猫 → 配认证/模型 → 连通性检查 → 自我介绍 → 任务 → 真实犯错 → 引入监督猫
4. 安装流程不再强制填写 API key，认证后置到引导中
5. 安装 client 补齐 opencode

CVO 明确拍板（2026-03-26）：
- 犯错机制采用“真实犯错”
- 作为独立 Feature 立项，不直接改写 F087
- 在独立 worktree/分支完成开发和验证后再考虑合入 main

## What

### Phase A: 模板/成员硬分层 + 零成员启动基线

- 运行态配置拆分为：
  - `Template Catalog`：角色模板（来自 `cat-template.json`）
  - `Runtime Members`：活跃成员（首次为空）
- API 与前端明确区分“模板选择数据”与“当前可调度成员数据”。
- 保证无成员时系统可启动、UI 可引导，不因空 roster 崩溃。

### Phase B: 安装器改造（认证后置 + opencode）

- `install.sh` 默认不进入逐客户端 API key/OAuth 问答。
- 认证迁移到首训引导“添加成员”步骤处理。
- CLI 检测与安装列表纳入 `opencode`。

### Phase C: First-Run Quest 首次引导入口

- 当检测到 `active members = 0` 时，打开应用触发新手引导弹窗：开始 / 跳过。
- 引导 Step：角色卡选模板 → 选 client（仅展示本机可用）→ 认证方式 → 模型 → 可用性探测。
- 创建第一只成员后触发“猫猫自我介绍”。

### Phase D: 任务桥接 + 真实犯错 + 双猫协作引入

- 首猫接任务（复用 F087 任务池或其子集）。
- 使用真实失败路径（lint/test/校验失败）触发“监督需求”。
- 引导创建第二只成员，并自动预填监督指令（如 `@小二 你来监督小一干活`）。
- 完成首训任务后，提示去 Console 继续管理成员与配置。

### Phase E: 迁移、回归与文档

- 旧项目迁移策略：已有成员保持兼容，不强制走首训。
- 补齐后端/前端/安装链路回归测试。
- 更新 README/SETUP 快速开始文档。

## Acceptance Criteria

### Phase A（模板/成员分层）
- [ ] AC-A1: 首次运行（无历史 catalog）时，`active members` 为空，服务与前端均能正常启动。
- [ ] AC-A2: 提供模板查询接口，返回完整模板库；成员接口仅返回活跃成员。
- [ ] AC-A3: mention 路由、候选列表、默认投递逻辑在零成员场景下不崩溃，且给出引导提示。

### Phase B（安装器）
- [ ] AC-B1: `install.sh` 默认安装流程不再要求用户填写 API key。
- [ ] AC-B2: 安装检测列表支持 `opencode`（检测+可选安装）。
- [ ] AC-B3: 安装结束后认证信息可在首训建猫流程中完成闭环。

### Phase C（首启引导）
- [ ] AC-C1: 无成员首次进入时自动弹出“开始新手教程/跳过”对话框。
- [ ] AC-C2: 创建第一只猫流程包含：模板选择、client 选择、认证、模型、探测。
- [ ] AC-C3: 成员创建成功后，猫猫自动发出自我介绍消息。

### Phase D（真实犯错 + 协作）
- [ ] AC-D1: 首训任务过程中使用真实失败事件触发“监督引导”。
- [ ] AC-D2: 引导新增第二只猫并自动预填监督指令。
- [ ] AC-D3: 完成首训后明确提示 Console 管理入口。

### Phase E（迁移与质量）
- [ ] AC-E1: 现有已配置项目升级后不丢成员、不破坏原有路由。
- [ ] AC-E2: 后端/前端/安装关键路径新增或更新测试通过。
- [ ] AC-E3: SETUP/README 文档完成更新并与实现一致。

## Dependencies

- **Evolved from**: F087（训练营机制可复用为任务后半段）
- **Related**: F110（训练营引导能力增强）
- **Related**: F127（运行时成员管理与动态创建）
- **Related**: F105（opencode client 接入基础）
- **Related**: F115（安装流程优化）

## Risk

| 风险 | 缓解 |
|------|------|
| 模板/成员拆分影响面大，可能破坏现有路由与 UI | 分 Phase 落地，先做接口分层与兼容适配，再切换默认行为 |
| 零成员导致默认消息发送或 mention 逻辑异常 | 增加零成员 guard + 明确错误文案 + 集成测试覆盖 |
| “真实犯错”不可预测，体验可能不稳定 | 采用可观测且高概率失败的任务模板，并提供 fallback 文案 |
| 安装器改动影响已有用户习惯 | 保留非交互安装兼容，文档明确认证后置路径 |

## Open Questions

| # | 问题 | 状态 |
|---|------|------|
| OQ-1 | 用户点击”跳过首训”后，是永久不再弹，还是仅本次跳过？ | ✅ 已定: 永久跳过（localStorage），铲屎官拍板 2026-03-26 |
| OQ-2 | 首训任务池是否直接复用 F087 的 Q1-Q6，还是裁剪一组更稳定的”可失败任务”子集？ | ✅ 已定: 裁剪 3 个高成功率+可见输出的任务子集（FRQ-1/2/3） |

## Key Decisions

| # | 决策 | 理由 | 日期 |
|---|------|------|------|
| KD-1 | 本能力独立立项为 F140，不并入 F087 | 首次上手与进阶训练营职责不同，降低改造耦合 | 2026-03-26 |
| KD-2 | 犯错机制采用“真实失败”而非模拟注入 | 用户感知更真实，能自然建立多猫 review 心智 | 2026-03-26 |
| KD-3 | 安装流程默认不问 API key，认证后置到建猫向导 | 降低首次安装门槛，减少阻塞 | 2026-03-26 |
| KD-4 | `cat-template` 与 `active members` 分层为硬边界 | 满足”首次 0 成员”与角色卡建猫能力 | 2026-03-26 |
| KD-5 | 跳过教程 = 永久（localStorage skip-v1） | 教程看一次即可，跳过的基本是老用户 | 2026-03-26 |
| KD-6 | 首训任务池独立于 F087，裁剪为 3 个轻量任务 | 高成功率 + 可见输出 + 真实可能出错 | 2026-03-26 |

## Timeline

| 日期 | 事件 |
|------|------|
| 2026-03-26 | F140 kickoff（独立 Feature） |
| 2026-03-26 | Phase A/B 完成: 零成员启动 + 模板分离 + 安装器改造（Maine Coon 实现，Ragdoll review） |
| 2026-03-26 | Phase C/D 完成: 首启向导 + 客户端检测 + quest 状态机 + QuestBanner + 前端集成（Ragdoll 实现） |

## Review Gate

- Phase A/B: Maine Coon 安全与兼容性 review 必过（P1 风险项清零）
- Phase C/D: Ragdoll 做体验与架构守门，CVO 做流程验收
- Phase E: 全链路回归（安装→首训→协作）通过后进入 merge gate

## Links

| 类型 | 路径 | 说明 |
|------|------|------|
| **Feature** | `docs/features/F087-cvo-bootcamp.md` | 复用训练营任务与 phase 机制 |
| **Feature** | `docs/features/F127-cat-instance-management.md` | 动态成员管理基础 |
| **Feature** | `docs/features/F105-opencode-golden-chinchilla.md` | opencode 接入基础 |
