# #1727 当前 fork 隔离验收（2026-11-05）

基线：`d9c564b583df9137140bd96f646b80f80aa48717`（当时的 fork `develop_base`，与只读核对到的运行 checkout 一致）。本次在原特性 worktree 的 `fix/plugin-1727-fork-acceptance-20261105` 分支完成开发和验证，未操作运行实例。上游 [#1728](https://github.com/zts212653/clowder-ai/pull/1728) 仍为 Draft / `a7a251e`，本报告不代表它已经同步当前基线。

## 结论与实际变化

当前 fork 的隔离旅程通过：安装 → 带同名挂载冲突启用 → 展示来源与位置 → 确认选择插件技能 → 重启 → 卸载 → 重装 → 再次启用。最终 `live=running`、`intent=enabled`、`skillConflicts=[]`，真实管理接口收到 6 次变更审计，浏览器无页面异常和失败 API 响应。

实物检查额外发现 P2 布局问题：390px 下顶部重启、卸载和开关挤压身份区域，插件名及版本变成逐字竖排，虽然原有“按钮可见、页面不溢出”检查均通过。新增标题可读性断言先在旧布局失败（`mobile actions must leave room for a readable plugin name`），再给身份区域设置 flex basis，让既有 `flex-wrap` 将操作移至下一行，修复后整条旅程通过。没有新增恢复机制或改变插件生命周期语义。

- [修复前手机画面](before-title-fix-390.png)
- [修复后手机画面](mobile-390.png)
- [修复后桌面画面](desktop-1280.png)
- [冲突展示](conflict-desktop.png)
- [实际请求、审计及最终投影](journey.json)

## 已验证的保留范围

- 用户同名技能目录在替换前仍保持原文；确认后进入唯一备份，卸载及重装后 `user.md` 原文仍在。
- 通过真实 Manager 配置写入的 `NOTE` 在重启、卸载、重装、启用后保留，配置文件字节逐次相同。
- 隔离项目内测试数据文件原文保留。
- 独立的 `helper` 技能在 `guide` 冲突时仍实际挂载并可读取，重装后仍可读取；旧受管 `guide` 断链正常迁移。
- 桌面 1280×800、手机 390×844 下滚至长详情末尾，重启和卸载仍在视口；标题不再逐字竖排，页面没有水平溢出。

测试使用生产 `PluginManagerLiveContent`、API transport、Fastify 管理路由及 guard、Manager、配置/包/库存存储与技能挂载。临时 HOME、独立文件及 SQLite 存储，不接 Redis；浏览器请求限制在本次启动的随机 loopback 端口。会话建立、空 agent-provider 列表和空远端目录刷新为 fixture 边界；文档与贡献工具读取使用真实 Host 实现。安装/重装使用真实本地目录 Manager/REST 入口，未覆盖操作系统目录选择器。`helper` 是实际第二项技能，不代表已验证任意插件的外部业务服务。

## 可重复命令和结果

在此 worktree 先按锁文件装依赖并构建 API：

```sh
env -u NODE_ENV -u npm_config_production -u NPM_CONFIG_PRODUCTION CI=1 pnpm install --frozen-lockfile
pnpm --filter @cat-cafe/api build
PLUGIN_1727_EVIDENCE_DIR=/tmp/plugin-1727-evidence pnpm --dir packages/web run test:browser:plugin-lifecycle
```

浏览器完整旅程 1/1 通过；最终一次用时约 57 秒。fixture 复用只读浏览器安装缓存，用户配置仍在临时 HOME。

```sh
pnpm --dir packages/api exec node scripts/with-test-home.mjs node --import tsx --import ./test/helpers/setup-cat-registry.js --test --test-concurrency=1 test/plugin-skill-conflicts.test.ts test/plugin-skill-lifecycle.journey.test.ts test/plugin-manager-restart.test.js test/plugin-manager-routes.test.js test/plugin-external-lifecycle.test.js
```

API 定向回归 76/76 通过，包含冲突、受阻/无权限挂载、重启恢复、revision fence 和卸载重装。

```sh
pnpm --dir packages/web exec node scripts/run-with-node-env-test.mjs pnpm exec vitest run src/components/settings/__tests__/PluginSkillConflicts.test.tsx src/components/settings/plugin-manager/__tests__
pnpm --dir packages/web exec node scripts/run-with-node-env-test.mjs pnpm exec vitest run src/components/settings/__tests__/PluginManagerV2.test.tsx src/components/settings/__tests__/PluginManagerNorthstar.test.tsx
```

前端 8 文件共 37/37 通过。API 构建、改动文件 Biome 和 `git diff --check` 通过；未宣称全仓门禁通过。

## 排查中的失败与边界

首次旧工位依赖安装停在非交互确认；随后发现继承的 `NODE_ENV=production` 使安装被仓库 guard 拒绝。按上述命令重装后，新版契约导出可用。首次浏览器因临时 HOME 找不到已安装 Chromium 而在启动前失败，后改为只读复用缓存。新测试的成功安装状态码最初误写成 200（实际契约为 201），以及未接齐的辅助只读路由，均已校准；没有因此修改生产契约或放宽失败响应检查。

本报告是当前 fork 代码的隔离验收，不能替代 operator 实例的实际体验确认和 fork soak；也未覆盖生产数据、插件业务数据库、任意外部服务或 [Collective 首次认领恢复 #153](https://github.com/zts212653/clowder-ai-plugins/pull/153)。未重启实例、未改运行配置，未推进上游 ready/merge。
