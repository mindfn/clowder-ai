# Guide Authoring

为新场景编写引导流程的标准 SOP：场景识别 → YAML 编排 → 标签标注 → 注册发现 → 测试验证。

## 核心知识

| 原则 | 说明 |
|------|------|
| 编排即产品 | Flow YAML 是终态产物，不是脚手架 |
| 页面零侵入 | 只加 `data-guide-id` 标签，不改业务逻辑 |
| 跨系统原生 | 外部步骤和内部步骤同等重要 |
| 猫猫可观测 | 每个步骤都要考虑观测上报 |

**前置依赖**：F150 Guide Engine + Guide Catalog 基础设施已就绪。

## 流程

### Step 1: 场景识别

确认需要引导的场景，产出"场景卡片"：

```yaml
# 场景卡片
scene_id: feishu-connector
scene_name: 配置飞书机器人
target_user: 新部署用户 / 需要接入飞书的团队
pain_point: 需要在飞书开放平台和 Console 之间来回操作，步骤易遗漏
complexity: high  # low / medium / high
cross_system: true  # 是否涉及外部系统
estimated_steps: 8
estimated_time: 10min
related_features: [F088, F134]
```

**判断标准**：
- complexity=high 或 cross_system=true → 必须做引导
- complexity=medium → 评估用户卡点频率再定
- complexity=low → 不做引导，文档即可

### Step 2: 步骤拆分 + YAML 编排

按六种步骤类型编排流程：

| 类型 | 用途 | 必需字段 |
|------|------|---------|
| `console_action` | Console 内操作 | target, action, instruction, page |
| `external_instruction` | 外部系统操作 | platform, instruction, reference_url |
| `collect_input` | 收集外部获取的值 | instruction, fields[] |
| `verification` | 自动验证 | verifierId |
| `branch` | 条件分支 | condition, true_next, false_next |
| `information` | 纯说明 | instruction |

**Flow YAML 模板**：

```yaml
id: {scene_id}
name: {scene_name}
description: {一句话描述}
tags: [{分类标签}]
estimated_time: {预计时间}
prerequisites: []  # 依赖的其他引导流程

steps:
  - id: step-1
    type: console_action
    target: "namespace.element"    # data-guide-id 值
    action: click                   # click / input / select
    instruction: "点击这里"
    page: /hub/cats                 # 当前应在哪个页面
    observe:                        # 观测配置（可选）
      fields:
        - key: field_name
          validate: "^regex$"
          sensitive: false
      on_error: notify_cat
      on_idle: 180s

  - id: step-ext
    type: external_instruction
    platform: feishu               # 外部平台标识
    instruction: |
      多行操作指引...
    prerequisites:                  # 前置条件声明（可选）
      - "微信版本 ≥ 8.0.50"
      - "已开通飞书开放平台账号"
    reference_url: "https://..."    # 外部文档链接
    assets:                         # 支持多张图片（非单张）
      - path: "guides/assets/{截图1}.png"
        caption: "第一步：打开扫一扫"
      - path: "guides/assets/{截图2}.png"
        caption: "第二步：扫描二维码"
    links:                          # 外部操作链接（可选）
      - url: "https://open.feishu.cn/..."
        label: "打开飞书开放平台"

  - id: step-collect
    type: collect_input
    instruction: "复制以下信息"
    fields:
      - key: app_id
        label: "App ID"
        validate: "^cli_[a-z0-9]+$"
      - key: app_secret
        label: "App Secret"
        sensitive: true

  - id: step-verify
    type: verification
    verifierId: "feishu-connection-test"  # 必须在后端 registry 注册
    success: "连接成功！"
    failure: "连接失败，请检查配置"
    retry: true
```

**编排规则**：
- 每个 flow 至少有 skip/cancel 退出路径
- `sensitive: true` 字段自动走 AC-S1 封存规则
- `verifierId` 必须在后端 registry 注册
- `skip_if` 只允许声明式（eq/in/exists/gt/lt）

### Step 3: 元素标签标注

给涉及的前端元素添加 `data-guide-id`：

```tsx
// 命名规则：{页面}.{区域}.{元素}
<button data-guide-id="nav.settings">设置</button>
<section data-guide-id="settings.connectors.feishu">
  <input data-guide-id="connectors.feishu.app-id-input" />
</section>
```

**标签命名约定**：
- 用点号分层，语义而非位置
- 避免 CSS class 名、索引号
- 标签一旦被 flow 引用即为契约，删改需走 CI 门禁

**产出**：更新 `guides/tag-manifest.yaml`（CI 用于契约校验）：

```yaml
# guides/tag-manifest.yaml
tags:
  nav.settings: { page: "/hub", component: "CatCafeHub.tsx" }
  settings.connectors.feishu: { page: "/hub/settings", component: "HubConnectorConfigTab.tsx" }
```

### Step 4: 注册到 Guide Registry

在 `guides/registry.yaml` 添加场景条目：

```yaml
- id: feishu-connector
  name: 配置飞书机器人
  keywords: [飞书, lark, feishu, 机器人对接, 飞书机器人]
  entry_page: /hub/settings/connectors
  estimated_time: 10min
  flow_file: guides/flows/feishu-connector.yaml
  cross_system: true
  priority: P0
```

**关键词设计原则**：
- 覆盖中英文同义词
- 包含用户可能的自然表达（"怎么接飞书"→ 匹配"飞书"）
- 不要太泛（避免误匹配）

### Step 5: 外部步骤资产准备

对每个 `external_instruction` 步骤：
1. 截取目标平台的操作界面截图
2. 用橙色圆圈标出关键操作位置
3. 存放到 `guides/assets/{scene_id}/` 目录
4. 在 YAML 的 `asset` 字段引用

### Step 6: CI 契约测试

确保以下校验全部通过（对应 AC-S3）：
- [ ] Flow schema 合法（step 类型/必需字段）
- [ ] Step graph 无死链/环路/孤儿
- [ ] 所有 `target` 在 tag-manifest.yaml 中存在
- [ ] `auto_fill_from` 源-汇类型兼容 + sensitivity 不越权
- [ ] `verifierId` 在后端 registry 存在
- [ ] `skip_if` 只用声明式 DSL
- [ ] 至少有 skip/cancel 退出路径

### Step 7: 端到端验证

1. 启动 dev 环境
2. 在聊天中触发引导（说匹配关键词）
3. 走完全流程：每步高亮正确 → 操作后自动推进 → 验证通过
4. 测试异常路径：跳过 → 刷新 → 卡住时猫猫介入

## Quick Reference

| 要做什么 | 文件 | 说明 |
|---------|------|------|
| 写新引导流程 | `guides/flows/{id}.yaml` | 按 Step 2 模板 |
| 加元素标签 | 前端组件 + `guides/tag-manifest.yaml` | 按 Step 3 命名约定 |
| 注册发现 | `guides/registry.yaml` | 按 Step 4 |
| 放截图 | `guides/assets/{id}/` | 按 Step 5 |
| 验证 | CI gate + 手动 E2E | 按 Step 6-7 |

## Common Mistakes

| 错误 | 后果 | 修复 |
|------|------|------|
| 标签用 CSS class 名 | UI 重构后引导失效 | 用语义命名 |
| 外部步骤不放截图 | 用户不知道在哪操作 | 每个 external_instruction 必须有 asset |
| 忘记注册 registry | 猫猫查不到引导 | Step 4 不可跳过 |
| sensitive 字段未标记 | 凭证泄露风险 | 所有密钥/token 必须 `sensitive: true` |
| verifier 未注册就引用 | CI 阻塞 | 先注册后端 verifier 再写 YAML |
| 关键词太泛 | 误匹配其他场景 | 用具体术语，避免"配置"等泛词单独出现 |
| 跳过 E2E 验证 | 线上引导卡死 | Step 7 是发布前必做 |

## 和其他 Skill 的区别

- `feat-lifecycle`：管理 Feature 生命周期 — guide-authoring 是写 **引导流程文档** 的 SOP
- `tdd`：代码的测试驱动 — guide-authoring 是 **YAML 编排** 的质量纪律
- `pencil-design`：出设计稿 — guide-authoring 定义引导 **逻辑和数据**，pencil 出 **视觉效果**

## 下一步

- 引导流程写完 → `pencil-design` 出 HUD/遮罩视觉稿
- 视觉稿确认 → `worktree` + `tdd` 实现 Guide Engine
- 实现完成 → `quality-gate` → `request-review`
