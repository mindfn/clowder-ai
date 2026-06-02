# F220 Phase A: Schedule Resource Framework — Implementation Plan

**Feature:** F220 — `docs/features/F220-github-plugin-schedule-resource.md`
**Goal:** Make `schedule` a first-class plugin resource type so plugins can declare scheduled tasks in plugin.yaml with lifecycle tied to enable/disable.
**Acceptance Criteria:**
- AC-A1: `parsePluginManifest` correctly parses `type: schedule` resources with `factoryId` validation
- AC-A2: `capabilities.json` supports `type: 'schedule'` entries; CLI config generation ignores them
- AC-A3: `PluginResourceActivator.activateSchedule()` creates TaskSpec via ScheduleFactoryRegistry and registers it
- AC-A4: `deactivateSchedule()` correctly unregisters TaskSpec + cleans capability entry
- AC-A5: Runtime plugin enable → schedule tasks auto-start (post-start register)
- AC-A6: Startup rehydrates enabled schedule resources
- AC-A7: Unit tests cover activate/deactivate/rehydrate/post-start scenarios
**Architecture cell:** plugin-system (F202 ownership)
**Map delta:** none
**Map delta why:** Extending existing plugin resource activation with a new resource type, no new ownership boundary.
**Architecture:** Extend F202's PluginResourceActivator with schedule resource handling. Introduce a ScheduleFactoryRegistry (white-list map of factoryId → TaskSpec factory). Plugin enable → lookup factory → register TaskSpec in TaskRunnerV2. Plugin disable → unregister. Use existing `registerDynamic()` which already handles post-start scheduling.
**Tech Stack:** TypeScript, node:test, TaskRunnerV2, PluginResourceActivator
**前端验证:** No — pure backend

---

## Straight-Line Check

**Finish line:** A plugin.yaml with `type: schedule` + `factoryId` resources gets parsed, activated (TaskSpec registered in TaskRunnerV2), deactivated (unregistered), and rehydrated on restart — all with test coverage.

**NOT building:** GitHub plugin.yaml (Phase B), PR/Issue tracking enhancements (Phase C/D), any UI changes.

**Terminal schema:**

```typescript
// PluginResourceDef (shared/types/plugin.ts) — already has schedule in union
interface PluginResourceDef {
  type: 'skill' | 'mcp' | 'limb' | 'schedule';
  factoryId?: string;  // NEW — required when type = 'schedule'
  // ... existing fields
}

// CapabilityEntry (shared/types/capability.ts) — add schedule
interface CapabilityEntry {
  type: 'mcp' | 'skill' | 'limb' | 'schedule';  // add 'schedule'
  scheduleTaskId?: string;  // NEW — runtime task ID for unregister
  // ... existing fields
}

// ScheduleFactoryRegistry — NEW
interface ScheduleFactory {
  factoryId: string;
  createTaskSpec(instanceId: string, deps: ScheduleFactoryDeps): TaskSpec_P1;
}
```

---

## Task 1: Extend shared types

**Files:**
- Modify: `packages/shared/src/types/plugin.ts:20-28`
- Modify: `packages/shared/src/types/capability.ts:48-52`

**Step 1.1: Add `factoryId` to PluginResourceDef**

```typescript
// plugin.ts L20-28 — add factoryId
export interface PluginResourceDef {
  type: 'skill' | 'mcp' | 'limb' | 'schedule';
  factoryId?: string;  // required for schedule resources
  path?: string;
  name?: string;
  command?: string;
  args?: string[];
  transport?: string;
  url?: string;
}
```

**Step 1.2: Add 'schedule' to CapabilityEntry type + scheduleTaskId field**

```typescript
// capability.ts L48-52 — extend type union + add scheduleTaskId
export interface CapabilityEntry {
  id: string;
  type: 'mcp' | 'skill' | 'limb' | 'schedule';
  enabled: boolean;
  // ... existing fields ...
  /** F220: runtime task ID assigned by TaskRunnerV2 (schedule resources only) */
  scheduleTaskId?: string;
}
```

**Step 1.3: Build to verify type changes compile**

Run: `cd packages/shared && pnpm build`
Expected: PASS (no consumers break — union widening is backward-compatible)

---

## Task 2: Manifest parser — support schedule resources

**Files:**
- Modify: `packages/api/src/domains/plugin/plugin-manifest.ts:21-22, 110-195`
- Test: `packages/api/test/plugin-manifest-safety.test.js`

**Step 2.1: Write failing test — schedule resource parsed correctly**

New test in `plugin-manifest-safety.test.js`:
```javascript
it('parses schedule resource with factoryId', () => {
  // Write temp plugin.yaml with type: schedule, factoryId: test-factory, name: test-schedule
  // Call parsePluginManifest(yamlPath)
  // Assert: resources includes { type: 'schedule', factoryId: 'test-factory', name: 'test-schedule' }
});

it('rejects schedule resource without factoryId', () => {
  // Write temp plugin.yaml with type: schedule but no factoryId
  // Assert: throws with message containing 'factoryId'
});

it('rejects schedule resource without name', () => {
  // Write temp plugin.yaml with type: schedule, factoryId but no name
  // Assert: throws with message containing 'name'
});
```

**Step 2.2: Run test to verify it fails**

Run: `pnpm test -- --test-name-pattern "schedule resource"`
Expected: FAIL (schedule is still deferred/skipped)

**Step 2.3: Implement — move schedule from DEFERRED to SUPPORTED + add validation**

```typescript
// plugin-manifest.ts
const SUPPORTED_RESOURCE_TYPES = new Set(['skill', 'mcp', 'limb', 'schedule']);
const DEFERRED_RESOURCE_TYPES = new Set<string>(); // empty — nothing deferred

// Inside parsePluginManifest, after existing type-specific validation (L170-185):
if (type === 'schedule') {
  const factoryId = rr['factoryId'];
  if (typeof factoryId !== 'string' || factoryId.trim().length === 0) {
    throw new Error(`Schedule resource in ${yamlPath} must have a 'factoryId' field`);
  }
  if (!name) {
    throw new Error(`Schedule resource in ${yamlPath} must have a 'name' field`);
  }
}

// In the resources.push() — include factoryId:
resources.push({
  type: type as PluginResourceDef['type'],
  factoryId: type === 'schedule' ? (rr['factoryId'] as string) : undefined,
  path, name, command: ..., args, transport, url: ...
});
```

**Step 2.4: Run test to verify it passes**

Run: `pnpm test -- --test-name-pattern "schedule resource"`
Expected: PASS

**Step 2.5: Commit**

```
feat(F220): manifest parser supports schedule resources
```

---

## Task 3: Create ScheduleFactoryRegistry

**Files:**
- Create: `packages/api/src/domains/plugin/ScheduleFactoryRegistry.ts`
- Test: `packages/api/test/schedule-factory-registry.test.js`

**Step 3.1: Write failing test**

```javascript
import { ScheduleFactoryRegistry } from '../src/domains/plugin/ScheduleFactoryRegistry.js';

it('registers and retrieves a factory', () => {
  const registry = new ScheduleFactoryRegistry();
  const factory = { factoryId: 'test', createTaskSpec: () => ({ /* minimal TaskSpec */ }) };
  registry.register(factory);
  assert.strictEqual(registry.get('test'), factory);
});

it('returns null for unknown factoryId', () => {
  const registry = new ScheduleFactoryRegistry();
  assert.strictEqual(registry.get('unknown'), null);
});

it('rejects duplicate factoryId', () => {
  const registry = new ScheduleFactoryRegistry();
  const factory = { factoryId: 'dup', createTaskSpec: () => ({}) };
  registry.register(factory);
  assert.throws(() => registry.register(factory), /already registered/);
});
```

**Step 3.2: Run test to verify it fails**

Expected: FAIL (module does not exist)

**Step 3.3: Implement ScheduleFactoryRegistry**

```typescript
// ScheduleFactoryRegistry.ts
import type { TaskSpec_P1 } from '../../infrastructure/scheduler/types.js';

export interface ScheduleFactoryDeps {
  log: { info: (...args: unknown[]) => void; error: (...args: unknown[]) => void };
  // Phase B will add: taskStore, routers, invokeTrigger, etc.
  [key: string]: unknown;
}

export interface ScheduleFactory {
  factoryId: string;
  createTaskSpec(instanceId: string, deps: ScheduleFactoryDeps): TaskSpec_P1;
}

export class ScheduleFactoryRegistry {
  private factories = new Map<string, ScheduleFactory>();

  register(factory: ScheduleFactory): void {
    if (this.factories.has(factory.factoryId)) {
      throw new Error(`Schedule factory '${factory.factoryId}' already registered`);
    }
    this.factories.set(factory.factoryId, factory);
  }

  get(factoryId: string): ScheduleFactory | null {
    return this.factories.get(factoryId) ?? null;
  }

  has(factoryId: string): boolean {
    return this.factories.has(factoryId);
  }
}
```

**Step 3.4: Run test → PASS**

**Step 3.5: Commit**

```
feat(F220): add ScheduleFactoryRegistry
```

---

## Task 4: PluginResourceActivator — activateSchedule / deactivateSchedule

**Files:**
- Modify: `packages/api/src/domains/plugin/PluginResourceActivator.ts:107-203`
- Test: `packages/api/test/plugin-schedule-activate.test.js` (new)

**Step 4.1: Write failing tests**

```javascript
// Test 1: activateSchedule registers task in TaskRunnerV2 + writes capability entry
// Test 2: deactivateSchedule unregisters task + removes capability entry
// Test 3: activateSchedule throws when factoryId not found in registry
// Test 4: activate then deactivate → task not running, capability gone
```

Mock ScheduleFactoryRegistry + TaskRunnerV2 (register/unregister stubs).

**Step 4.2: Run → FAIL**

**Step 4.3: Implement**

Add to `PluginResourceActivatorDeps`:
```typescript
scheduleFactoryRegistry?: ScheduleFactoryRegistry;
taskRunner?: { registerDynamic: (task: AnyTaskSpec, defId: string) => void; unregister: (taskId: string) => boolean };
scheduleFactoryDeps?: ScheduleFactoryDeps;
```

Add switch case in `activateResource`:
```typescript
case 'schedule':
  await this.activateSchedule(manifest, resource);
  break;
```

And in `deactivateResource`:
```typescript
case 'schedule':
  await this.deactivateSchedule(manifest, resource);
  break;
```

```typescript
private async activateSchedule(manifest: PluginManifest, resource: PluginResourceDef): Promise<void> {
  if (!resource.factoryId) throw new Error('Schedule resource must have a factoryId');
  if (!resource.name) throw new Error('Schedule resource must have a name');
  if (!this.deps.scheduleFactoryRegistry) throw new Error('ScheduleFactoryRegistry not configured');
  if (!this.deps.taskRunner) throw new Error('TaskRunner not configured');

  const factory = this.deps.scheduleFactoryRegistry.get(resource.factoryId);
  if (!factory) throw new Error(`Unknown schedule factory '${resource.factoryId}'`);

  const capId = resourceCapId(manifest.id, resource);
  const taskId = `plugin-${manifest.id}-${resource.name}`;

  const taskSpec = factory.createTaskSpec(taskId, this.deps.scheduleFactoryDeps ?? { log: console });
  this.deps.taskRunner.registerDynamic(taskSpec, `plugin:${manifest.id}:${resource.name}`);

  await this.upsertCapabilityEntry(manifest, resource, true, undefined, taskId);
}

private async deactivateSchedule(manifest: PluginManifest, resource: PluginResourceDef): Promise<void> {
  if (!resource.name) return;
  if (!this.deps.taskRunner) return;

  // Read current capability to get scheduleTaskId
  const config = await this.deps.readCapabilities();
  const capId = resourceCapId(manifest.id, resource);
  const entry = config?.capabilities.find(
    c => normalizeCapId(c.id) === capId && c.pluginId === manifest.id
  );
  const taskId = entry?.scheduleTaskId;
  if (taskId) {
    this.deps.taskRunner.unregister(taskId);
  }

  await this.removeCapabilityEntry(manifest, resource);
}
```

Update `upsertCapabilityEntry` signature to accept optional `scheduleTaskId`.

**Step 4.4: Run → PASS**

**Step 4.5: Commit**

```
feat(F220): PluginResourceActivator handles schedule resources
```

---

## Task 5: Rehydrate schedule resources at startup

**Files:**
- Modify: `packages/api/src/domains/plugin/PluginResourceActivator.ts` (add `rehydrateEnabledPluginSchedules`)
- Test: `packages/api/test/plugin-schedule-activate.test.js` (extend)

**Step 5.1: Write failing test**

```javascript
// Test: rehydrateEnabledPluginSchedules registers tasks for enabled schedule capabilities
// Given: capabilities.json has enabled schedule entry with pluginId + scheduleTaskId
// And: ScheduleFactoryRegistry has matching factory
// When: rehydrateEnabledPluginSchedules called
// Then: factory.createTaskSpec called + taskRunner.register called
```

**Step 5.2: Run → FAIL**

**Step 5.3: Implement**

```typescript
export async function rehydrateEnabledPluginSchedules(deps: {
  capabilities: CapabilitiesConfig | null;
  pluginRegistry: Pick<PluginRegistry, 'getManifest'>;
  scheduleFactoryRegistry: ScheduleFactoryRegistry;
  taskRunner: { register: (task: AnyTaskSpec) => void };
  scheduleFactoryDeps: ScheduleFactoryDeps;
  log?: Pick<Console, 'info' | 'warn'>;
}): Promise<void> {
  if (!deps.capabilities) return;

  const scheduleEntries = deps.capabilities.capabilities.filter(
    c => c.type === 'schedule' && c.enabled && c.pluginId
  );

  for (const cap of scheduleEntries) {
    const manifest = deps.pluginRegistry.getManifest(cap.pluginId!);
    if (!manifest) continue;

    const scheduleResource = manifest.resources.find(
      r => r.type === 'schedule' && resourceCapId(manifest.id, r) === normalizeCapId(cap.id)
    );
    if (!scheduleResource?.factoryId) continue;

    const factory = deps.scheduleFactoryRegistry.get(scheduleResource.factoryId);
    if (!factory) {
      deps.log?.warn(`[F220] Skip rehydration for factory '${scheduleResource.factoryId}' (not registered)`);
      continue;
    }

    const taskId = cap.scheduleTaskId ?? `plugin-${manifest.id}-${scheduleResource.name}`;
    try {
      const taskSpec = factory.createTaskSpec(taskId, deps.scheduleFactoryDeps);
      deps.taskRunner.register(taskSpec);
      deps.log?.info(`[F220] Rehydrated schedule '${scheduleResource.name}' for plugin '${manifest.id}'`);
    } catch (err) {
      deps.log?.warn(`[F220] Failed to rehydrate schedule for '${manifest.id}': ${(err as Error).message}`);
    }
  }
}
```

**Step 5.4: Run → PASS**

**Step 5.5: Commit**

```
feat(F220): rehydrate schedule resources at startup
```

---

## Task 6: Integration — wire everything in boot sequence

**Files:**
- Modify: `packages/api/src/index.ts` (add registry init + pass deps to activator + rehydrate call)
- No separate test — covered by existing startup smoke tests + Task 4-5 unit tests

**Step 6.1: In index.ts, create ScheduleFactoryRegistry and wire into PluginResourceActivator**

```typescript
// After TaskRunnerV2 creation, before plugin scan:
const scheduleFactoryRegistry = new ScheduleFactoryRegistry();
// Phase B will register GitHub factories here

// Pass to PluginResourceActivator deps:
scheduleFactoryRegistry,
taskRunner: { registerDynamic: (t, d) => taskRunnerV2.registerDynamic(t, d), unregister: (id) => taskRunnerV2.unregister(id) },
scheduleFactoryDeps: { log: app.log, /* Phase B will add more */ },
```

**Step 6.2: Before `taskRunnerV2.start()`, call rehydrate**

```typescript
await rehydrateEnabledPluginSchedules({
  capabilities: await readCapabilities(),
  pluginRegistry,
  scheduleFactoryRegistry,
  taskRunner: taskRunnerV2,
  scheduleFactoryDeps: { log: app.log },
  log: app.log,
});
```

**Step 6.3: Build + baseline test**

Run: `pnpm build && pnpm test`
Expected: All pre-existing tests still pass (no behavioral change — no factories registered yet)

**Step 6.4: Commit**

```
feat(F220): wire ScheduleFactoryRegistry into boot sequence
```

---

## Verification Plan

| AC | Evidence |
|----|----------|
| AC-A1 | `plugin-manifest-safety.test.js` — schedule parse + factoryId validation |
| AC-A2 | Type union widened; CLI config generation naturally ignores (no mcpServer) |
| AC-A3 | `plugin-schedule-activate.test.js` — activate creates TaskSpec via factory |
| AC-A4 | `plugin-schedule-activate.test.js` — deactivate unregisters + cleans cap |
| AC-A5 | `registerDynamic()` already handles post-start (existing behavior) |
| AC-A6 | `plugin-schedule-activate.test.js` — rehydrate test |
| AC-A7 | All above test files |
