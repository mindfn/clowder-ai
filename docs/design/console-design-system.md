# Console Design System

> Cat Cafe Console 的视觉语言规范。所有前端组件必须遵循本文档。
> 参考系：macOS System Settings + Linear + Vercel Dashboard

## 1. 设计原则

### 1.1 层次通过背景色建立，不通过边框

**核心规则**：同层内容用背景色区分，跨层才加边框。

```
窗口背景 (--console-shell-bg)
  └─ 面板背景 (--console-panel-bg)        ← 无边框，靠色差
      └─ 卡片背景 (--console-card-bg)     ← 无边框，靠色差
          └─ 内嵌区域 (--console-card-soft-bg) ← 无边框，靠色差
```

**何时加边框**：
- 列表项之间的分隔线（仅 `border-b`，用 `--console-border-soft`）
- 输入框/表单控件的边界
- 需要用户注意的区域边界（警告/错误卡片）
- 拖拽区域的虚线边框

**何时不加边框**：
- 卡片与面板之间 — 用背景色差
- 导航栏与内容区之间 — 用背景色差
- 统计卡片/指标卡片 — 用背景色填充 + 圆角
- 标签页/分段控件 — 用激活态背景色

### 1.2 留白即层次

- 组件之间用 `gap` 而非边框分隔
- 标准间距阶梯：`4px` / `8px` / `12px` / `16px` / `24px` / `32px`
- 面板内边距：`16px`（紧凑） / `24px`（标准）
- 卡片内边距：`12px`（紧凑） / `16px`（标准）

### 1.3 克制的圆角

- 面板/大容器：`12px`（`rounded-xl`）
- 卡片/中型容器：`10px`（`rounded-[10px]`）
- 按钮/输入框：`8px`（`rounded-lg`）
- 标签/徽章：`6px`（`rounded-md`）
- 头像/图标容器：`full`（`rounded-full`）

### 1.4 动效克制

- 过渡时间：`180ms ease`（标准） / `120ms`（微交互）
- 入场动画：仅面板级，`translateY(8px) → 0`，`200ms`
- 禁止：弹跳、旋转、闪烁（游戏模式除外）

---

## 2. Token 使用规则

### 2.1 背景色

| 层级 | Token | Tailwind | 用途 |
|------|-------|----------|------|
| 窗口 | `--console-shell-bg` | CSS 直接引用 | 最外层壳 |
| 面板 | `--console-panel-bg` | `bg-[var(--console-panel-bg)]` | 侧边栏、主内容区 |
| 卡片 | `--console-card-bg` | `bg-[var(--console-card-bg)]` | 独立信息块、设置项分组 |
| 内嵌 | `--console-card-soft-bg` | `bg-[var(--console-card-soft-bg)]` | 卡片内的子区域、代码块 |
| 凹陷 | `--console-code-bg` | `bg-[var(--console-code-bg)]` | 输入框内部、代码预览 |
| 强调 | `--console-active-bg` | `bg-[var(--console-active-bg)]` | 当前选中项 |
| 悬停 | `--console-hover-bg` | `bg-[var(--console-hover-bg)]` | 悬停反馈 |
| 药丸 | `--console-pill-bg` | `bg-[var(--console-pill-bg)]` | 标签、徽章 |

**禁用列表**：
- `bg-white` — 用 `bg-cafe-surface` 或 `bg-[var(--console-card-bg)]`
- `bg-gray-*` — 用对应的 console token
- `bg-cafe-surface-elevated` 作为卡片背景 — 用 `--console-card-bg`（它已经基于 elevated 混合）

### 2.2 边框

| 场景 | Token | Tailwind |
|------|-------|----------|
| 列表分隔线 | `--console-border-soft` | `border-b border-[var(--console-border-soft)]` |
| 表单控件边框 | `--console-border-soft` | `border border-[var(--console-border-soft)]` |
| 强分隔（罕见） | `--console-border-strong` | `border border-[var(--console-border-strong)]` |

**禁用列表**：
- `border-cafe` / `border-cafe-subtle` 在新世界组件中 — 用 console token
- `border` 不带颜色指定 — 必须显式指定 console token
- 卡片四周加边框 — 改用背景色 + 圆角

### 2.3 文字

| 层级 | Token | Tailwind |
|------|-------|----------|
| 主文字 | `--cafe-text` | `text-cafe` |
| 次要文字 | `--cafe-text-secondary` | `text-cafe-secondary` |
| 弱化文字 | `--cafe-text-muted` | `text-cafe-muted` |
| 强调色文字 | `--cafe-accent` | `text-cafe-accent` |

### 2.4 阴影

- 面板/弹层：`--console-shadow`
- 悬浮卡片：`--console-shadow-soft`
- 普通卡片：**不加阴影**（靠背景色差区分）

---

## 3. 组件模式

### 3.1 设置项分组（macOS grouped list）

```
┌─────────────────────────────────────────┐  ← console-card-bg, rounded-xl
│  标题行                    操作按钮      │  ← 16px padding
│─────────────────────────────────────────│  ← border-b console-border-soft
│  设置项 A          [开关/值]            │
│─────────────────────────────────────────│  ← border-b console-border-soft
│  设置项 B          [开关/值]            │
│─────────────────────────────────────────│  ← border-b console-border-soft
│  设置项 C          [开关/值]            │  ← 最后一项无 border-b
└─────────────────────────────────────────┘
```

- 外部容器：`bg-[var(--console-card-bg)] rounded-xl`
- 项与项之间：`border-b border-[var(--console-border-soft)]`
- 最后一项：无 border-b
- 组与组之间：`gap-6`（24px）

### 3.2 统计卡片

```
┌──────────────┐  ← console-card-bg, rounded-xl, NO border
│  数值  12     │
│  标签  在线    │  ← text-cafe-secondary
└──────────────┘
```

- 纯背景色填充，**无边框**
- 数值：`text-xl font-semibold`
- 标签：`text-sm text-cafe-secondary`

### 3.3 列表行（Signal/Memory/Thread 列表）

```
┌─────────────────────────────────────────┐
│  [图标]  标题              时间戳        │  ← hover:bg-[var(--console-hover-bg)]
│          摘要文字...                     │
├─────────────────────────────────────────┤  ← border-b console-border-soft
│  [图标]  标题              时间戳        │
│          摘要文字...                     │
└─────────────────────────────────────────┘
```

- 行内无边框，行间用 `border-b`
- hover 态：`bg-[var(--console-hover-bg)]`
- 选中态：`bg-[var(--console-active-bg)]`

### 3.4 搜索框

```
┌──────────────────────────────────────┐
│  🔍  搜索内容...                      │  ← console-card-soft-bg, rounded-lg
└──────────────────────────────────────┘
```

- 背景：`bg-[var(--console-card-soft-bg)]`
- 边框：`border border-[var(--console-border-soft)]`（仅 focus 时加深为 `--console-border-strong`）
- 宽度：跟随内容区域，**不超过 400px**
- 禁止：满宽搜索框、强调色按钮紧贴搜索框

### 3.5 按钮

| 类型 | 样式 | 用途 |
|------|------|------|
| 主要 | `console-button-primary` | 唯一主操作（每个视图最多 1 个） |
| 次要 | `console-button-secondary` | 辅助操作 |
| 幽灵 | `console-button-ghost` | 工具栏、紧凑操作 |

- 主按钮：`bg-cafe-accent text-cafe-accent-foreground rounded-lg px-4 py-2`
- 次按钮：`bg-[var(--console-card-bg)] border border-[var(--console-border-soft)] rounded-lg px-4 py-2`
- 幽灵：`hover:bg-[var(--console-hover-bg)] rounded-lg px-3 py-1.5`

### 3.6 标签/徽章

- 背景：`bg-[var(--console-pill-bg)] rounded-md px-2 py-0.5`
- 状态标签：使用 `console-status-chip` 的 data-status 变体
- 字号：`text-xs`

### 3.7 空状态

- 居中图标 + 标题 + 描述
- 图标：`text-cafe-muted`，32px
- 标题：`text-lg font-medium text-cafe`
- 描述：`text-sm text-cafe-secondary`
- 可选操作按钮：次要按钮样式

---

## 4. 页面布局模式

### 4.1 设置页（双栏）

```
┌────────┬──────────────────────────────────┐
│ 侧边栏  │  内容区                           │
│ 分类列表 │  ┌──────────────────────────────┐ │
│         │  │ 标题 + 描述                    │ │
│         │  ├──────────────────────────────┤ │
│         │  │ 设置项分组 A                   │ │
│         │  ├──────────────────────────────┤ │
│         │  │ 设置项分组 B                   │ │
│         │  └──────────────────────────────┘ │
└────────┴──────────────────────────────────┘
```

- 侧边栏：`bg-[var(--console-panel-bg)]`，无右边框
- 内容区：`bg-[var(--console-shell-bg)]` 或同色
- 分组间距：`gap-6`

### 4.2 列表页（Signal Inbox / Memory Feed）

```
┌──────────────────────────────────────────┐
│  导航栏  [tab1] [tab2]    [搜索框]        │
├──────────────────────────────────────────┤
│  列表行 1                                 │
│  列表行 2                                 │
│  列表行 3                                 │
└──────────────────────────────────────────┘
```

- 导航栏：与内容区同背景，tab 用背景色区分激活态
- 搜索框：右对齐，最大宽度 400px
- 列表：行间 `border-b`，无外框

### 4.3 详情页

```
┌──────────────────────────────────────────┐
│  ← 返回   标题                            │
├──────────────────────────────────────────┤
│  主内容区域                               │
│  ┌────────────────────────────────────┐  │
│  │ 卡片分组                            │  │
│  └────────────────────────────────────┘  │
└──────────────────────────────────────────┘
```

---

## 5. 反模式清单（Don'ts）

| 反模式 | 正确做法 |
|--------|---------|
| 卡片四周加 `border` | 用 `bg-[var(--console-card-bg)] rounded-xl` |
| 满宽强调色按钮 | 按钮定宽 `w-auto`，右对齐或居中 |
| 面板间加 `border-r` / `border-l` | 用背景色差区分 |
| 统计卡片加边框 | 用背景色填充 |
| 搜索框 100% 宽度 | `max-w-[400px]` |
| 用 `bg-white` / `bg-gray-100` | 用 console token |
| Feature ID 出现在 UI 上（如 "F127"） | 用用户可理解的功能名 |
| 同一页面混用框线卡片和无框线卡片 | 全部统一为无框线 |
| `border-cafe` / `border-cafe-subtle` 在新组件中使用 | 用 `border-[var(--console-border-soft)]` |
| 术语不一致（"会话" vs "对话" vs "thread"） | 统一用"对话" |

---

## 6. 术语规范

| 内部术语 | 用户面展示 |
|---------|----------|
| thread | 对话 |
| signal | 信号 |
| memory / knowledge | 记忆 |
| settings | 设置 |
| session | 会话 |
| connector | 连接器 |
| worktree | 工作区 |
| MCP | MCP 服务 |
| skill | 技能 |
| cat / agent | 猫猫 / 助手 |

---

## 7. 自检清单

每次提交前端代码前对照：

- [ ] 没有新增 `border-cafe` / `border-cafe-subtle`（用 console token）
- [ ] 卡片容器用背景色而非边框
- [ ] 同一视图内视觉元素风格一致
- [ ] 无 Feature ID / 内部标识暴露给用户
- [ ] 搜索框宽度不超过 400px
- [ ] 每个视图最多 1 个主按钮
- [ ] hover/active 状态使用 console token
- [ ] 文字层级不超过 3 级（主/次/弱）
- [ ] 术语符合第 6 节规范
- [ ] 深色模式下通过 token 自动适配（不硬编码颜色）
