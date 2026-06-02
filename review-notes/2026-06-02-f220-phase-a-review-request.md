# Review Request: F220 Phase A — Schedule Resource Framework

**Review-Target-ID**: f220
**Branch**: `feat/f220-plugin-schedule-resource`
**Author**: 宪宪/claude-opus-4-6
**Reviewer**: @codex (缅因猫)
**Date**: 2026-06-02

---

## What

Make `schedule` a first-class plugin resource type in the F202 plugin framework. Plugins can now declare `type: schedule` resources in plugin.yaml with `factoryId` + `name`, and the framework handles full lifecycle: parse → activate (register in TaskRunnerV2) → deactivate (unregister) → rehydrate on restart.

## Why

铲屎官原话（`docs/features/F220-github-plugin-schedule-resource.md`）：
> "github相关的定时任务都是硬编码的；定时任务好像也不支持脚本的？"
> "触发的逻辑我理解应该是按照定时任务按照正常的定时任务的流程和逻辑执行然后来触发的"

Phase A builds the framework mechanism; Phase B will migrate GitHub's 4 hardcoded tasks to use it.

## Architecture Ownership

- **Architecture cell**: plugin-system (F202 ownership)
- **Map delta**: none
- **Why**: Extending existing PluginResourceActivator with a new resource type (schedule). ScheduleFactoryRegistry is a white-list registry inside the existing plugin domain, not a new ownership boundary.

**Reviewer请检查**: diff 中是否有超出 plugin-system cell 的新并行 Store/Queue/Router/Adapter？（预期答案：没有。ScheduleFactoryRegistry 是 registry 不是 store）

## Tradeoff

- **factoryId 白名单 vs 任意脚本**: 选择白名单（KD-3），安全但 Phase B 需要手动注册每个 factory。Trade-off: 牺牲灵活性换取安全边界
- **registerDynamic vs register**: activateSchedule 用 registerDynamic（处理 post-start），rehydrate 用 register（start 前）。Trade-off: 两个路径，但语义正确

## Changed Files (9 files)

| File | Change | Lines |
|------|--------|-------|
| `packages/shared/src/types/plugin.ts` | Add `factoryId` to PluginResourceDef | +2 |
| `packages/shared/src/types/capability.ts` | Add `'schedule'` to type union + `scheduleTaskId` | +4 |
| `packages/api/src/domains/plugin/plugin-manifest.ts` | Move schedule DEFERRED→SUPPORTED, validation | +18/-2 |
| `packages/api/src/domains/plugin/ScheduleFactoryRegistry.ts` | NEW — white-list factory registry | +52 |
| `packages/api/src/domains/plugin/PluginResourceActivator.ts` | activateSchedule/deactivateSchedule + rehydrate | +100/-3 |
| `packages/api/src/index.ts` | Wire registry into boot sequence | +22/-1 |
| `packages/api/test/plugin-manifest-safety.test.js` | 3 schedule tests (replace old deferred test) | +44/-4 |
| `packages/api/test/schedule-factory-registry.test.js` | NEW — 6 registry tests | +78 |
| `packages/api/test/plugin-schedule-activate.test.js` | NEW — 7 activation + 4 rehydration tests | +265 |

## Open Questions (Technical — for reviewer)

1. **upsertCapabilityEntry complexity**: Adding `scheduleTaskId` parameter pushed the method signature to 5 params. Worth refactoring to an options object, or acceptable for now given existing pattern matches (limb already has `limbNodeId`)?
2. **CapabilityEntry type cast**: `resource.type as CapabilityEntry['type']` — safe because manifest parser validates, but reviewer may prefer a runtime guard.

## Self-Check Evidence

**Quality Gate**: PASS (2026-06-02 15:07 UTC)
- 79/79 tests pass (3 manifest + 6 registry + 7 activation + 4 rehydration + 59 pre-existing)
- Biome: 0 errors
- pnpm lint: 0 errors
- pnpm build: exit 0
- Follow-up tail scan: clean
- Hotfix pattern scan: clean
- Artifact hygiene: clean

---

[宪宪/claude-opus-4-6🐾]
