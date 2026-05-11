# F197 Plugin Framework — Phase 1 Implementation Plan

**Feature:** F197 — `docs/features/F197-plugin-framework.md`
**Goal:** 建立通用插件框架——`plugins/` 目录放 `plugin.yaml` 即可被系统发现、配置、启用，资源自动激活
**Acceptance Criteria:**
1. 放一个只有 config + skill 的空插件 → UI 展示配置面板 → 保存凭证 → 启用后 skill 可见
2. 放一个有 limb 的插件 → 启用后 limb 注册 + CapabilityEntry 写入 → Skill UI 联动
3. 禁用 → skill symlink 移除 + CapabilityEntry(enabled:false) 保留 → skill 灰显
4. 部分资源激活失败 → UI 显示哪些成功哪些失败 → 可重试
**Architecture:** PluginRegistry 扫描 `plugins/` 目录发现 manifest → PluginResourceActivator 按 resource type 分发到已有 registry（CapabilityEntry/LimbRegistry/symlink）→ 状态从 manifest + capabilities.json + env 派生，不新建状态文件
**Tech Stack:** TypeScript, Fastify, React, YAML (js-yaml), capabilities.json
**前端验证:** Yes — PluginsContent + PluginConfigPanel + Skill 灰显需浏览器实测

---

## Terminal Schema

```typescript
// packages/shared/src/types/plugin.ts

interface PluginConfigField {
  envName: string;
  label: string;
  sensitive: boolean;
  required: boolean;
}

interface PluginHealthCheck {
  limbCommand?: string;
  mcpProbe?: string;
}

interface PluginResourceDef {
  type: 'skill' | 'mcp' | 'limb' | 'schedule';
  path?: string;          // skill, limb
  name?: string;          // mcp
  command?: string;        // mcp (stdio)
  args?: string[];         // mcp (stdio)
  transport?: string;      // mcp
}

interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  icon?: string;
  builtin?: boolean;
  config: PluginConfigField[];
  healthCheck?: PluginHealthCheck;
  resources: PluginResourceDef[];
}

type PluginStatus = 'enabled' | 'configured' | 'not_configured' | 'partial';

interface PluginResourceStatus {
  type: string;
  path?: string;
  name?: string;
  enabled: boolean;
  error?: string;
}

interface PluginInfo {
  id: string;
  name: string;
  version: string;
  description?: string;
  icon?: string;
  status: PluginStatus;
  configured: boolean;
  config: (PluginConfigField & { currentValue: string | null })[];
  healthCheck?: PluginHealthCheck;
  resources: PluginResourceStatus[];
  hasHealthCheck: boolean;
}

// CapabilityEntry 扩展（加 pluginId）
interface CapabilityEntry {
  // ... existing fields ...
  pluginId?: string;  // NEW: 标记此 entry 归属哪个插件
}

// CapabilityBoardItem 扩展
interface CapabilityBoardItem {
  // ... existing fields ...
  pluginId?: string;  // NEW: 前端用于灰显判断
}
```

---

## Task 1: Shared Types — Plugin + CapabilityEntry Extension

**Files:**
- Create: `packages/shared/src/types/plugin.ts`
- Modify: `packages/shared/src/types/capability.ts:48-67` — add `pluginId?`
- Modify: `packages/shared/src/types/capability.ts:82-113` — add `pluginId?` to board item
- Modify: `packages/shared/src/index.ts` — re-export plugin types

**Steps:**
1. Create `plugin.ts` with PluginManifest, PluginConfigField, PluginHealthCheck, PluginResourceDef, PluginStatus, PluginResourceStatus, PluginInfo types
2. Add `pluginId?: string` to CapabilityEntry (line 67)
3. Add `pluginId?: string` to CapabilityBoardItem (line 113)
4. Add re-export in shared index
5. Run `pnpm lint` to verify types
6. Commit: "feat(F197): add plugin shared types + extend CapabilityEntry with pluginId"

---

## Task 2: Plugin Manifest Parser + Env Safety Validator

**Files:**
- Create: `packages/api/src/domains/plugin/plugin-manifest.ts`
- Test: `packages/api/src/__tests__/domains/plugin/plugin-manifest.test.ts`

**What it does:**
- `parsePluginManifest(yamlPath): PluginManifest` — parse + validate plugin.yaml
- `validateEnvSafety(manifest, existingClaims): { ok, errors[] }` — three-layer check:
  1. System denylist (CAT_CAFE_*, REDIS_*, NODE_OPTIONS, etc.)
  2. Plugin-ID prefix for non-builtin (envName must start with `{ID_UPPER}_`)
  3. Cross-plugin collision (envName not in existingClaims)

**Steps:**
1. Write failing tests: valid manifest parse, invalid YAML rejected, denylist rejects REDIS_URL, prefix rejects non-prefixed community env, collision detected
2. Implement parser (js-yaml load + schema check + env safety)
3. Run tests green
4. Commit: "feat(F197): plugin manifest parser with env safety validation"

---

## Task 3: PluginRegistry — Discovery + State Derivation

**Files:**
- Create: `packages/api/src/domains/plugin/PluginRegistry.ts`
- Test: `packages/api/src/__tests__/domains/plugin/PluginRegistry.test.ts`

**What it does:**
- `scan(pluginsDir): PluginManifest[]` — scan `plugins/*/plugin.yaml`, validate each, skip invalid (log warning), detect env collisions
- `deriveStatus(manifest, capabilities, env): PluginStatus` — from three truth sources:
  - all required config have values → 'configured'
  - all resources enabled in capabilities → 'enabled'
  - some enabled → 'partial'
  - else → 'not_configured'
- `getPluginInfo(manifest, capabilities, env): PluginInfo` — full info with config masking (sensitive → null, non-sensitive → first 6 chars + ****)

**Steps:**
1. Write failing tests: scan finds plugins, skips invalid, derives correct status for each scenario
2. Implement PluginRegistry
3. Run tests green
4. Commit: "feat(F197): PluginRegistry with scan + state derivation"

---

## Task 4: PluginResourceActivator — Skill + Limb + MCP

**Files:**
- Create: `packages/api/src/domains/plugin/PluginResourceActivator.ts`
- Test: `packages/api/src/__tests__/domains/plugin/PluginResourceActivator.test.ts`

**Dependencies:** PluginRegistry, LimbRegistry, capability-orchestrator, skill-parse

**What it does:**
- `enablePlugin(manifest, opts): { status, resources[] }` — per resource:
  - **skill**: symlink to provider skill dirs + write CapabilityEntry(pluginId)
  - **limb**: load YAML → adapter factory → LimbRegistry.register() + CapabilityEntry(pluginId)
  - **mcp**: write CapabilityEntry(pluginId) + generateCliConfigs() + probe
- `disablePlugin(manifest, opts): { status, resources[] }` — per resource:
  - **skill**: remove symlink + set CapabilityEntry(enabled:false, pluginId preserved)
  - **limb**: LimbRegistry.deregister() + remove CapabilityEntry
  - **mcp**: remove CapabilityEntry + regenerate CLI configs
- Transaction: partial success OK, return per-resource result, idempotent

**Adapter factory:** Map of `adapterName → (config) => ILimbNode`. Phase 1 only has `weixin-mp` built-in.

**Steps:**
1. Write failing tests: enable skill creates symlink + entry, disable removes symlink + marks entry, enable limb registers + entry, enable returns partial on failure
2. Implement activator with injected dependencies (LimbRegistry, capability read/write, skill dirs)
3. Run tests green
4. Commit: "feat(F197): PluginResourceActivator with skill/limb/mcp lifecycle"

---

## Task 5: Skill Prune Exemption for Plugin-Owned Entries

**Files:**
- Modify: `packages/api/src/routes/capabilities.ts:679-685` — prune filter

**What it does:**
Add `pluginId` exemption to prune filter. Plugin-owned skills (CapabilityEntry has `pluginId`) should NOT be pruned even if not found on filesystem.

**Change:**
```typescript
// Before (line 683):
config.capabilities = config.capabilities.filter(
  (c) => c.type !== 'skill' || allSkillNames.has(c.id)
);

// After:
config.capabilities = config.capabilities.filter(
  (c) => c.type !== 'skill' || allSkillNames.has(c.id) || c.pluginId
);
```

**Steps:**
1. Write failing test: plugin-owned skill entry with pluginId survives prune even when not in allSkillNames
2. Apply one-line fix
3. Run tests green
4. Commit: "feat(F197): exempt plugin-owned skills from filesystem prune"

---

## Task 6: Plugin API Routes

**Files:**
- Create: `packages/api/src/routes/plugin-routes.ts`
- Modify: `packages/api/src/routes/plugin-hub.ts` — deprecate/redirect old routes
- Test: `packages/api/src/__tests__/routes/plugin-routes.test.ts`

**Routes:**
| Method | Path | Handler |
|--------|------|---------|
| GET | `/api/plugins` | List all discovered plugins (PluginInfo[]) |
| GET | `/api/plugins/:id` | Single plugin detail |
| POST | `/api/plugins/:id/enable` | Enable (PluginResourceActivator.enablePlugin) |
| POST | `/api/plugins/:id/disable` | Disable (PluginResourceActivator.disablePlugin) |
| POST | `/api/plugins/:id/config` | Write config (plugin-scoped env, safety validated) |
| POST | `/api/plugins/:id/test` | Health check (only if manifest declares healthCheck) |

**Config write logic:**
1. Validate envName ∈ manifest.config
2. Validate envName ∉ system denylist (redundant but defense-in-depth)
3. Write to `.env.local` via existing `applyConnectorSecretUpdates()` logic
4. Return updated plugin status

**Steps:**
1. Write failing tests for each route (happy path + error cases)
2. Implement routes
3. Run tests green
4. Commit: "feat(F197): plugin API routes (CRUD + config + enable/disable + test)"

---

## Task 7: Wire Up in index.ts

**Files:**
- Modify: `packages/api/src/index.ts` — initialize PluginRegistry, register routes, auto-activate enabled plugins on startup

**What it does:**
1. Initialize PluginRegistry with `plugins/` dir
2. Scan on startup → for already-enabled plugins, re-activate resources (limb re-register, skill re-mount)
3. Register plugin routes
4. Keep existing hardcoded weixin-mp registration for now (Phase 2 removes it)

**Steps:**
1. Add PluginRegistry initialization after LimbRegistry setup
2. Call scan → re-activate enabled plugins
3. Register plugin routes
4. Run `pnpm lint` + existing tests
5. Commit: "feat(F197): wire PluginRegistry into API startup"

---

## Task 8: Frontend — PluginsContent Refactor

**Files:**
- Modify: `packages/web/src/components/settings/PluginsContent.tsx` — from hardcoded to dynamic

**What it does:**
- Replace `PLUGIN_CATALOG` hardcoded array with `GET /api/plugins` fetch
- Render plugin cards from API response (name, status, icon, config fields)
- Each card expandable with config form + action buttons
- Keep GitHub-specific config panel for now (GithubConfigPanel) as fallback

**Steps:**
1. Replace useEffect to fetch from `/api/plugins` instead of static catalog
2. Map PluginInfo → card rendering (status badge, icon, description)
3. Add expand/collapse for config section
4. Run dev server, verify in browser
5. Commit: "feat(F197): PluginsContent dynamic from API"

---

## Task 9: Frontend — PluginConfigPanel (Generic)

**Files:**
- Create: `packages/web/src/components/settings/PluginConfigPanel.tsx`
- Modify: `packages/web/src/components/settings/PluginsContent.tsx` — use new panel

**What it does:**
- Generic config form: renders fields from `PluginInfo.config[]`
  - text input for non-sensitive, password input for sensitive
  - placeholder shows currentValue or "未设置"
- Save button → `POST /api/plugins/:id/config`
- Enable/Disable button → `POST /api/plugins/:id/enable` or `disable`
- Test button (only if `hasHealthCheck`) → `POST /api/plugins/:id/test`
- Resource status display (per-resource enabled/error badges)

**Steps:**
1. Create PluginConfigPanel component
2. Integrate into PluginsContent expanded card view
3. Run dev server, test with mock plugin
4. Commit: "feat(F197): generic PluginConfigPanel component"

---

## Task 10: Frontend — Skill UI Plugin Gating

**Files:**
- Modify: `packages/web/src/components/settings/CapabilitiesContent.tsx` (or wherever skill list renders)

**What it does:**
- When rendering skill items, check `pluginId` field from CapabilityBoardItem
- If `pluginId` is set and `enabled: false` → gray out + show "需先启用「{pluginName}」插件"
- Plugin name resolved from `/api/plugins` response (can cache)

**Steps:**
1. Add pluginId check in skill rendering logic
2. Gray-out styling + tooltip/badge
3. Verify in browser
4. Commit: "feat(F197): skill UI gray-out for disabled plugin skills"

---

## Task 11: Test Plugin Directory

**Files:**
- Create: `plugins/test-skill-only/plugin.yaml` — minimal plugin with just a skill
- Create: `plugins/test-skill-only/skills/test-skill/SKILL.md` — trivial skill file

**What it does:**
Provides a concrete plugin for AC #1 verification (config + skill only → UI renders → enable → skill visible).

```yaml
# plugins/test-skill-only/plugin.yaml
id: test-skill-only
name: Test Skill Plugin
version: "1.0.0"
description: 验证用测试插件（仅包含 skill）
config:
  - envName: TEST_SKILL_ONLY_API_KEY
    label: API Key
    sensitive: true
    required: true
resources:
  - type: skill
    path: skills/test-skill
```

**Steps:**
1. Create plugin directory + manifest + skill file
2. Restart API, verify `GET /api/plugins` returns it
3. Fill config → enable → verify skill visible in Skill UI
4. Disable → verify skill grayed out
5. Commit: "test(F197): add test-skill-only plugin for verification"

---

## Task 12: End-to-End Verification

Run all 4 acceptance criteria:

1. **AC #1**: test-skill-only plugin → UI shows config panel → save key → enable → skill visible
2. **AC #2**: (Phase 2 plugin, but can test with existing weixin-mp if hardcoded registration coexists)
3. **AC #3**: Disable test-skill-only → symlink removed → CapabilityEntry(enabled:false) → skill grayed
4. **AC #4**: Create plugin with intentionally broken limb path → enable → partial success UI

Commit: "test(F197): end-to-end acceptance verification"

---

## Execution Order

```
Task 1 (types)
  → Task 2 (manifest parser)
    → Task 3 (registry)
      → Task 4 (activator)
        → Task 5 (prune exemption)
          → Task 6 (API routes)
            → Task 7 (wire up)
              → Task 8 (frontend: PluginsContent)
                → Task 9 (frontend: ConfigPanel)
                  → Task 10 (frontend: skill gating)
                    → Task 11 (test plugin)
                      → Task 12 (e2e verification)
```

Linear dependency chain. Each task builds on the previous. No parallel tracks needed — each is small enough that sequential TDD is efficient.
