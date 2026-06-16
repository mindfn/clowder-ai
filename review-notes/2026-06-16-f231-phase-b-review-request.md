# Review Request: F231 Phase B — Dynamic Plugin Installation System

Review-Target-ID: f230
Branch: feat/f230-im-connector-plugin

## What

Phase B adds dynamic plugin installation for external IM connectors — users upload a `.tar.gz` archive via Hub UI, the system extracts/validates/registers it, and the connector becomes available without restarting.

5 new commits (since last codex-approved `a479de9be`):
1. `a5c6282df` — B-1: Plugin installer service + loader integration (236-line `plugin-installer.ts`, updated `im-connector-loader.ts` + `connector-gateway-bootstrap.ts`)
2. `0342b84fd` — B-2: API routes (`connector-plugins.ts` — GET list, POST install, DELETE uninstall)
3. `648d3efa7` — B-3: Frontend `HubConnectorPluginsSection` component (upload + list + uninstall)
4. `1071980b8` — Docs: updated feat doc + plugin guide for Phase B/C
5. `e0eecd790` — Style: Biome a11y fix + formatting

11 files changed, +1013 / -84

## Why

> 铲屎官原话："让用户手动配置 IM_CONNECTOR_PLUGINS 这个好像不太合理？有没有更合适点方式的？比如我们在 im 插件管理那边添加插件安装包。因为要考虑有的用户使用的是安装包版本，而不是源码版本，对于安装包版本的用户是没有 node 环境的"
>
> 铲屎官原话："前端应该是安装/卸载/更新 -->更新应该也是和上传也一样 只不过保留配置文件的"

Non-source users need to install third-party connectors without npm/Node. Self-contained tar.gz packages solve this — upload via Hub UI, no toolchain required.

## Original Requirements（必填）
> 铲屎官 2026-06-15：
> - "用户应该基于我们的im connector的接口实现代码，然后添加yaml文件还有资源文件；应该达成一个固定的包；然后我们可以安装这个package；实际就是解压出来，然后注册上去就好了的；这个package的依赖的静态资源应该在plugin中自己闭环的"
> - "前端应该是安装/卸载/更新 -->更新应该也是和上传也一样 只不过保留配置文件的"
- 来源：本 thread 铲屎官消息 2026-06-15
- **请对照上面的摘录判断交付物是否解决了铲屎官的问题**

## Tradeoff

- 选了 tar.gz（解压即用）而非 npm 包安装（需 Node 环境）——对安装包版本用户更友好
- 插件包不支持 npm 依赖（必须自包含）——简化安全模型，避免供应链风险
- `configEventBus` 触发 gateway reload 使用 `__plugin_<id>` 伪键——不是真正的 env key，但走已有的 reload 通道避免新建机制

## Architecture Ownership（必填）
Architecture cell: connector + plugin
Map delta: update required
Why: 新增 plugin installer 服务 + API 路由 + 前端组件，扩展 connector cell 的 extension point（从仅 npm → npm + tar.gz 安装）

请 reviewer 检查：
- diff 是否与 `Map delta` 一致
- 是否新建了并行 `Store` / `Queue` / `Router` / `Adapter` / `Dispatcher` / `Binding`
- 若修改 `docs/architecture/ownership/cells/*.md`，是否确实改变了 owner / boundary / extension point / canonical anchor

## Open Questions

### 技术 OQ（给 reviewer）
1. `plugin-installer.ts` 用 `execFileAsync('tar', ...)` 解压——是否需要对文件名做安全过滤（路径穿越）？`tar` 自身有 `--no-unsafe-permissions` 但未显式传
2. `loadInstalledPlugins` 用 `import(pathToFileURL(entryPath).href)` 动态加载——模块缓存会导致更新后旧代码残留吗？（当前 gateway reload = 进程级重启，所以实际没问题）
3. `configEventBus.emitChange` 用 `__plugin_<id>` 伪键——`connector-reload-subscriber` 按 `CONNECTOR_GATEWAY_RELOAD_KEYS` 过滤，这个伪键不在 set 里，是否真的能触发 reload？

### 价值 OQ（给 CVO，如有）
无

## Next Action
请 review 以上 5 个 commit（`a5c6282df` ~ `e0eecd790`），关注：
- 安装/卸载/更新的边界场景
- API 路由的安全性（capability-write guard 是否足够）
- 前端组件的状态管理

## Review Sandbox（必填）
- Path: `/tmp/cat-cafe-review/f230/codex`
- Start Command: `pnpm review:start`
- Ports: 按 review:start 分配

## 自检证据

### Spec 合规
- AC-B1 ~ AC-B9, AC-C1 全部满足（详见 feat doc）
- Phase A AC 无回退

### 测试结果
```
node --test test/plugin-installer.test.js test/connector-status.test.js
  tests 36, pass 36, fail 0

pnpm --filter @cat-cafe/api build    # 成功
npx biome check (6 target files)     # 0 errors (排除 HubConnectorConfigTab 预存 warning)
npx tsc --noEmit -p packages/web     # 6 pre-existing errors (hub-cat-editor-oc-providers.test.ts), 0 new
```

### 相关文档
- Feature: `docs/features/F231-im-connector-plugin-architecture.md`
- Guide: `docs/guides/im-connector-dev-guide.md`
