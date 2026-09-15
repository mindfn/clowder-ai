# #770 设置体验审计（2026-09-15）

> 触发：co-creator 体验验收反馈——"风格格格不入；真正需要让用户了解的没体现；需要配置的不理解；部分还要手动改 env；还有的改了不生效（比如 log 级别）……我们不能一直这样子"。
> 审计对象：`feat/770-terminal-consolidation` @ `3b72f947a`（System 设置页）。
> 方法：四路并行调查（生效语义 / upstream 用户痛点 / 设计体系一致性 / 原生目录选择器先例）+ 关键结论逐条亲手复核。
> 核实标记：**[V]** = opus 亲手读过代码路径或原文；**[A]** = 调查 agent 报告、带 file:line、未经 opus 逐条复核；**[I]** = 推断。

## 0. 一句话结论

#770 把设置当成"把环境变量投影到页面"（单位 = env var），而用户的单位是"我要知道什么、我要决定什么"。co-creator 指出的五类问题都是这个坐标系错位的直接后果；四轮逐点修补无法收敛。另外 System 页当前带着多个**已证实的回归**，不可上游。

## 1. 根因

### 1.1 坐标系错位
env var 的生效方式天然异构——每次调用读 / 模块加载读一次 / 启动脚本重建 / 构建期固化 / 桌面版根本不读 / 被 `.env.local` 遮蔽——而页面把它们统一压平成"保存到 .env，重启后生效"。结果是"改了不生效"成了一整类，而不是个例。

### 1.2 偏离了我们自己 08-31 的 spec（opus 评审口径造成）
`docs/plans/770-config-consolidation-spec.md` 的目标本来是对的 **[V]**：
- "像正常桌面应用：合理默认值 + **只露出用户真正要决定的少数几项** + 没有 env 墙"
- Design decision 2："系统参数 → 折叠的『系统信息（高级）』**只读**区"

第三轮 co-creator 指出"灰色死控件"，opus 给 kimi 的口径是"不许有没理由的只读、全部做成能改"，于是 `c5195c723` 把 28 个系统参数全部开放编辑——其中多数是 Redis key 前缀、Story 数据目录这类用户不该做决定的管道参数，同时把"改了不生效"的暴露面放大到 24 个需重启变量。co-creator 的原意是"**形态 = 可用性**"（状态就显示成状态，别伪装成控件），不是"全部可编辑"。

### 1.3 过程
- 跳过 `console-dev` 的 Gate 1（Product）与 Gate 2（Design-System），四轮都是"截图反馈 → 改代码 → 再截图"。
- 复审验证的是"控件在不在、代码对不对"，**从未做过"改一个值 → 生效路径 → 观察读取方"的效果测试**。下文 D3（局域网开关）即在 opus 批准的那一轮引入。

## 2. 已证实缺陷（"改了不生效"类）

| # | 缺陷 | 证据 | 引入 | 核实 |
|---|---|---|---|---|
| D1 | **保存后页面跳回旧值**：保存 → `onSaved={load}` 重新拉取 → `currentValue` 读 `process.env`（需重启变量 PATCH 不改 process.env）→ `useEffect` 按新数据重置草稿 → 控件显示旧值，"N 项需重启"提示消失。24 个需重启变量全中。 | `HubSystemSettingsTab.tsx:37`；`SystemSettingsView.tsx:215-222`（注释 "mount + post-save refetch"）；`env-registry.ts` `buildEnvSummary` 读 `process.env` | #770 | [V] |
| D2 | **日志级别**：(a) 模块加载时读一次常量，只有**完整停掉并重跑启动脚本**才生效；API 的 `while true; tsx watch` 重启继承启动时冻结的环境；Hub 无重启入口。(b) 未设置时 `initialDraftValue` = `''`，`<select value="">` 无匹配项，界面显示 `fatal`（实际 `info`）。(c) 桌面版不读 `.env`，永不生效。——**即 issue #1062（2026-07-01，open）**，#770 把它重新开放编辑（据调查 upstream 现为只读 [A]），原样暴露。 | `logger.ts:22-23`；`packages/api/package.json:8`；API 无 dotenv；`start-dev.sh:1084-1086`（仅 `--debug` 覆盖）；`EnvSubComponents.tsx:129-133`；`SystemSettingsView.tsx` select 分支；#1062 正文 | #770 重新暴露 | [V]（(b) 的浏览器显示首项为标准 DOM 行为） |
| D3 | **局域网访问开关一旦关闭无法再从 Hub 打开**：toggle 恒写 `'1'/'0'`，读取方要求 `=== 'true'`；显示逻辑按 `exactTrue` 判定，写入 `'1'` 后开关也显示为关。`PROJECT_ALLOWED_ROOTS_APPEND` 同病。 | `SystemSettingsView.tsx:62`；`frontend-origin.ts:121`；`project-path.ts:76`；`SystemSettingsView.tsx:16-30` | `c5195c723`（opus 批准） | [V] |
| D4 | **Redis 连接地址是死控件**：`setup_storage` 两个分支都无条件 `export REDIS_URL="redis://localhost:$REDIS_PORT"`。外部贡献者在 #620 评论里报告过同一现象 [A]。 | `start-dev.sh:1478,1502`（setup_storage 已运行 / 新启动两分支） | 暴露于 #770 | [V] |
| D5 | **内存模式开关在任何启动方式下都不生效**（启动脚本总是导出 REDIS_URL 或退出；`--memory` 强制；桌面版固定）。 | `start-dev.sh:1449,1476-1478,1500-1514`；`desktop/service-manager.js:700-705` | 暴露于 #770 | [A] |
| D6 | **桌面版**：Hub 写入 `<userData>/project/.env`，但桌面版启动不读它 → 所有需重启变量在桌面版永不生效；3 个即时变量重启后丢失。 | `desktop/service-manager.js:464-507`；与 #1062 正文互证；API 无 dotenv [V] | 既有 | [A]+[V] 互证 |
| D7 | **`.env.local` 遮蔽不可见**：Hub 只写 `.env`，启动脚本后 source `.env.local`；本 worktree 中端口×3、REDIS_URL、DEFAULT_OWNER_USER_ID 均被遮蔽，页面毫无提示。 | `start-dev.sh:159-169`；`routes/config.ts:161-162` | 既有 | [V]（加载顺序）/[A]（遮蔽清单） |
| D8 | **错误描述**：「平台数据目录（~/.cat-cafe）」写着存放 accounts/credentials——实际这两者走 `CAT_CAFE_GLOBAL_CONFIG_ROOT`，否则 `projectRoot ?? homedir()`。 | `env-registry.ts:1125-1126`；`account-store-topology.ts:25-27`；`credentials.ts:5` | `3b72f947a`（opus 批准） | [V] |
| D9 | **文案与事实不符**：TTL 占位写"604800 = 7天"，真实默认 0（不过期）；即时生效变量保存后也提示"重启后生效"。 | `env-registry.ts:774-775`；`RedisMessageStore.ts:111`；`SystemSettingsView.tsx:273` | #770 | [A] |
| D10 | 其他：`MAX_A2A_DEPTH` 回调触发的 A2A 硬编码 10、值 0 变 15；端口在 offset≠0 / 继承环境恢复 / `.env.local` 下被覆盖；`CLI_TIMEOUT_MS` 不控制 stall kill（#854）。 | 见生效语义表出处 | 既有 | [A] |

## 3. 生效语义（28 个 System 变量，dev · runtime · desktop）

| 类别 | 变量 | 结论 |
|---|---|---|
| 真·即时 | CLI_TIMEOUT_MS、PROJECT_ALLOWED_ROOTS、PROJECT_DENIED_ROOTS | 每次调用读取，PATCH 同步 process.env → 立即生效；但保存文案仍说"重启后生效" |
| 即时但坏 | PROJECT_ALLOWED_ROOTS_APPEND、CORS_ALLOW_PRIVATE_NETWORK（开启方向） | D3：永不生效 |
| 完整重启才生效 | LOG_LEVEL、6 个 TTL、DATA_DIR、CACHE_DIR、DOCS_ROOT、ANNOTATION_DATA_DIR、CAT_CAFE_DATA_DIR、FRONTEND_URL、API_SERVER_HOST、PREVIEW_GATEWAY_ENABLED、REDIS_KEY_PREFIX、MAX_A2A_DEPTH | dev/runtime：仅完整重跑启动脚本；桌面：永不（D6）；受 D7 遮蔽 |
| 条件性不生效 | API_SERVER_PORT、FRONTEND_PORT、PREVIEW_GATEWAY_PORT | offset≠0、继承环境恢复、`.env.local` 存在时被覆盖；前端 API 地址依赖构建期 `NEXT_PUBLIC_API_URL` |
| 永不生效 | REDIS_URL、MEMORY_STORE | D4、D5 |
| 按设计只读 | DEFAULT_OWNER_USER_ID | 信任锚点，PATCH 400（正确）；但"手改 .env"说明忽略了 `.env.local` |

完整逐变量表（含读取点 file:line 与各部署模式）见调查记录；关键行已在 §2 复核。

## 4. 用户真实痛点（upstream zts212653/clowder-ai issues，约 110 个已读）[A]

| 模式 | 规模 | 代表证据 |
|---|---|---|
| **模型接入不透明，卡住第一次回复**（API key vs OAuth、账号绑定成员、transport、base URL 形态、CLI 是否安装） | 外部用户最大簇，约 14 个 | #1088、#1229/#1228、#1303、#585、#904、#1113、#338、#539、#1253、#1159 |
| **不知道数据在哪、会不会丢** | 约 12 个，含外部用户静默内存模式跑一整天后全部丢失（#1250 [V]） | #473、#1250、#922、#620、#1132、#1169、#961、#842 |
| **改了不生效；界面显示请求值/默认值而非生效值** | 约 13 个 | #1062 [V]、#620、#854、#1208（维护者："用户很难知道哪个真正生效"）、#1381、#1302、#490 |
| **文档化的设置仍需手改** | 文档约 30 处手改指令；11 个 issue 的解法是手改 | #1303、#1142、#1027、#1023、#1302、#880、#273、#1070、#675 |
| **文档漂移、互相矛盾、内部术语** | — | Node 版本、DEFAULT_OWNER_USER_ID（.env.example vs SETUP.md）、NEXT_PUBLIC_API_URL |

**Redis 数据目录三个答案 [V]**：`SETUP.md:210` 写 `~/.cat-cafe/redis-dev/`；Hub（`routes/config.ts:302`）显示 `~/.cat-cafe/redis-dev-sandbox`；`pnpm start`/`start:direct` 走 `--profile=opensource` 实际用 `~/.cat-cafe/redis-opensource`（运行实例环境变量亦证实）。

**含义**：用户首先需要看到的是**状态**——数据是否持久化、存在哪、局域网是否开放、有无待重启改动、模型能否连通——而不是端口号与 TTL 秒数。最痛的模型接入不在 System 页。

## 5. 风格为何格格不入

已核实 [V]：
- 开关用的是 IM connector 品牌色 `bg-conn-emerald-text`（设计体系规定开关用 accent；同页桌面更新面板用的就是 accent 开关）。
- 同一页两个「保存到 .env」主按钮（`SystemSettingsView.tsx:327`、`EnvSubComponents.tsx:387`）、两个「打开 .env ↗」（`:283`、`:389`）。
- 全仓 67 个原生 `<select>`、分布在 45 个文件、各自样式——**没有任何轻量「值 ⌄」下拉原语**，这是公共件缺口而非单页问题。
- `DirPickerField`（#770）未复用 F113 已有的 `ThreadSidebar/DirectoryBrowser`，重复实现了第二个网页目录浏览器。

调查报告 [A]：
- 重的填充输入框形态由 #770 `ff88e9eda` 引入；upstream 合并基上是右对齐纯文本。
- System 页未使用兄弟页已在用的公共件：`SettingsResourceToggleSwitch`（13 处使用）、`SettingsCollapsibleCard`、`SettingsSecondaryButton` 等；同页四种容器样式；产品文案里有 changelog 口吻（"三段式不变。新增：…"）。
- 视觉契约测试对 `SystemSettingsView` / `DirPickerField` 零覆盖，因此翠绿开关、无 focus ring 的 select 能通过。
- 需要新建的原语：分组列表容器、设置行（标题 + 一行说明 + 右侧控件 + 可选"需重启"徽标）、轻量 select、点击编辑值、时长/单位控件、路径行（原生对话框优先 + 清除）、目录列表管理（+ 添加目录…）、行内空状态、统一开关、带遮罩与 Esc 的 modal 壳。

待调和的约束：视觉契约测试有一条"select 保留原生箭头（no appearance-none）"，但只锁 4 个文件，出处随 squash `31105179e` 进入、无法追溯决策来源；与轻量下拉的取舍在 Design Gate 以 A/B 截图决定（F056:662）。

## 6. 目录选择器：历史与方案

- **F068** Key Decision 1–2 [V]：本地应用由后端调用 `osascript` 弹原生选择器（`showDirectoryPicker()` 拿不到绝对路径）；"**自建浏览器体验始终不如系统原生**"，删掉自建浏览器。
- **F113** [V]：因 osascript 在 Linux/Windows 不可用，改为网页目录浏览器；**AC-D1**："目录选择器前端主路径不依赖任何 OS 特定 API"，保留 `/api/projects/pick-directory` 兼容路由。
- **现状** [V]：`projects.ts` 已有 macOS `osascript`（:53）与 Windows `FolderBrowserDialog`（:23）；但无 UI 调用、仅做身份校验不校验本机来源、无无桌面环境检测 [A]。桌面版经 Electron `dialog.showOpenDialog` 原生选择 [A]。
- **方案**：原生优先（macOS osascript / Windows PowerShell / Linux zenity·kdialog·portal，严格本机来源 guard + 无 GUI 检测）→ 远程/无桌面/不支持时回退**唯一**网页浏览器（复用 F113 `DirectoryBrowser`，删除 #770 重复实现）。这修订 F113 AC-D1，须在 F113 文档中显式记录决策变更。

## 7. 方向与阶段

1. **#770 暂不上游**：现版本含 D1/D3/D8 等已证实回归。upstream PR #1344（head 分支为 `fix/770-section-projection`、已 DIRTY、标题描述已放弃的窄版本）挂起一个月无说明——方向确认后关闭并留说明，过门禁后另开干净 PR。
2. **P0 正确性修复（设计无关，立即做）**：布尔序列化（D3，按 `booleanSemantics` 全量审计同类）；LOG_LEVEL 即时生效（运行时设 `logger.level`，API 仅 2 个子 logger）+ 未设置时显示真实生效级别（D2a/b）；死控件退出可编辑面（D4/D5）；错误文案（D8/D9）；API 返回 `savedValue`（目标 `.env` 中的值）与遮蔽来源（`.env.local`），页面显示"已保存 X，当前生效 Y，等待完整重启"而非回跳（D1/D7）。**每项必须带效果测试**（改值 → 读取方观察到新值 / 被正确标注为待重启或不可用）。
3. **Gate 1 Product**：按用户坐标系重做清单——状态（要让用户看到的）/ 决策（用户真正要做的）/ 隐藏；每项写清生效方式（即时 / 需完整重启 / 此部署方式不可用）与用户语言文案、人类单位；回到 08-31 spec 方向；状态矩阵（loading/empty/error × dev/runtime/desktop × owner/非 owner）。
4. **Gate 2 Design**：可点击设计稿（轻量设置行、原生目录对话框、待重启状态、数据持久化状态），co-creator 以 A/B 截图签字后再实现。
5. **Gate 3/4**：实现 + 效果测试 + 渲染证据 + 兄弟页抽样。
6. **不纳入 #770、另立 feature**：模型接入配置的可理解性（外部用户痛点第一）；兄弟设置页迁移到新原语；文档漂移清理。
