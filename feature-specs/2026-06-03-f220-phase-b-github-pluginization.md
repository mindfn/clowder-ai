# F220 Phase B: GitHub Pluginization — Implementation Plan

**Feature:** F220 — `docs/features/F220-github-plugin-schedule-resource.md`
**Goal:** Migrate GitHub from pseudo-plugin to real plugin.yaml plugin — config through plugin-config-store, 4 pollers through schedule resource framework, connector-hub GitHub entry removed.
**Acceptance Criteria:**
- AC-B1: `plugins/github/plugin.yaml` includes config declaration + 4 schedule resources
- AC-B2: GitHub config through plugin-config-store read/write, not connector-hub → .env
- AC-B3: `index.ts` has no hardcoded GitHub task registration code
- AC-B4: Disable GitHub plugin → 4 pollers stop; enable → resume
- AC-B5: connector-hub PLATFORMS has no GitHub platform definition
- AC-B6: Frontend config panel correctly reads/writes GitHub plugin config
- AC-B7: Existing pr_tracking tasks continue working after migration (backward compat)
**Architecture cell:** plugin (F202 ownership)
**Map delta:** none
**Map delta why:** Migrating existing GitHub connector into existing plugin framework — no new ownership boundary.
**Architecture:** Wrap 4 existing TaskSpec factory functions (`createCiCdCheckTaskSpec` etc.) as `ScheduleFactory` implementations registered in `ScheduleFactoryRegistry`. GitHub `plugin.yaml` declares these factories by `factoryId`. Enable/disable lifecycle handled by Phase A framework. Config flows through `resolvePluginEnv` with automatic `.env` fallback (KD-6). Poller logic untouched (KD-7).
**Tech Stack:** TypeScript, node:test, PluginResourceActivator, ScheduleFactoryRegistry, plugin.yaml
**Front-end verification:** Yes — GitHub config panel migration to PluginConfigPanel

---

## Straight-Line Check

**Finish line:** GitHub plugin declared in `plugins/github/plugin.yaml`, 4 pollers registered through schedule framework, config managed by plugin-config-store, connector-hub cleaned, frontend uses `PluginConfigPanel`.

**NOT building:**
- Not changing poller logic (KD-7: global pollers stay as-is)
- Not migrating other connector platforms (feishu, weixin)
- Not adding schedule management UI
- Not implementing Phase C (PR tracking enhancements) or Phase D (issue tracking)

**Terminal schema:**

```yaml
# plugins/github/plugin.yaml
id: github
name: GitHub
version: 1.0.0
description: "GitHub PR tracking, CI/CD monitoring, conflict detection, and repository scanning"
icon: github
builtin: true
docsUrl: "https://docs.github.com/en/authentication/..."
setupSteps:
  - "Create a GitHub Personal Access Token (needs repo + notifications permissions)"
  - "Fill in the token to enable PR Tracking, Review Router, CI/CD Monitor"
  - "Optional: configure Noise Bot list to reduce setup-only comment noise"

config:
  - envName: GITHUB_TOKEN
    label: "Personal Access Token"
    sensitive: true
    required: true
  - envName: GITHUB_SETUP_NOISE_BOT_LOGINS
    label: "Noise Bot Login List"
    sensitive: false
    required: false
  - envName: GITHUB_MCP_PAT
    label: "MCP Token"
    sensitive: true
    required: false

resources:
  - type: schedule
    name: cicd-check
    factoryId: github.cicd-check
  - type: schedule
    name: conflict-check
    factoryId: github.conflict-check
  - type: schedule
    name: review-feedback
    factoryId: github.review-feedback
  - type: schedule
    name: repo-scan
    factoryId: github.repo-scan
```

```typescript
// GitHubScheduleDeps — typed dep extraction for GitHub factories
interface GitHubScheduleDeps extends ScheduleFactoryDeps {
  taskStore: ITaskStore;
  cicdRouter: CiCdRouter;
  conflictRouter: ConflictRouter;
  reviewFeedbackRouter: ReviewFeedbackRouter;
  invokeTrigger: ConnectorInvokeTrigger;
  checkMergeable: (repo: string, pr: number) => Promise<{ mergeState: string; headSha: string }>;
  autoExecutor: ConflictAutoExecutor;
  fetchPrMetadata: (repo: string, pr: number) => Promise<PrMetadata | null>;
  fetchComments: (repo: string, pr: number, sinceId?: number) => Promise<PrFeedbackComment[]>;
  fetchReviews: (repo: string, pr: number, sinceId?: number) => Promise<PrReviewDecision[]>;
  isEchoComment: (c: { author: string }) => boolean;
  isEchoReview: (r: { author: string }) => boolean;
  isNoiseComment: (c: { author: string }) => boolean;
  // repo-scan deps (optional — not available when redis is not configured)
  repoAllowlist?: string[];
  inboxCatId?: string;
  defaultUserId?: string;
  reconciliationDedup?: ReconciliationDedup;
  bindingStore?: IConnectorThreadBindingStore;
  deliverFn?: typeof deliverConnectorMessage;
  deliveryDeps?: ConnectorDeliveryDeps;
  fetchOpenPRs?: (repo: string) => Promise<GhPrItem[]>;
  fetchOpenIssues?: (repo: string) => Promise<GhIssueItem[]>;
}
```

**Key design decisions:**
1. Each existing `createXxxTaskSpec` gets optional `id?: string` (backward compat — defaults to current ID)
2. Factory wrappers extract typed deps from `ScheduleFactoryDeps` via `GitHubScheduleDeps` cast
3. Inline helper functions (checkMergeable, fetchPrMetadata, etc.) stay in `index.ts` as part of deps bag assembly — poller logic untouched per KD-7
4. repo-scan factory throws gracefully if redis-dependent deps missing → activator records resource failure, other 3 succeed
5. `resolvePluginEnv` already falls back to `process.env` — zero migration code for existing `.env` users (KD-6)
6. `GithubConfigPanel` removed; `PluginConfigPanel` handles GitHub config generically

---

## Task 1: Add `id` Parameter to TaskSpec Factories

Existing factory functions hardcode their task ID. Schedule factories need to pass the plugin-scoped `instanceId` (e.g., `schedule:github:cicd-check`). Add optional `id` to all 4 factory option types.

**Files:**
- Modify: `packages/api/src/infrastructure/email/CiCdCheckTaskSpec.ts:23,41`
- Modify: `packages/api/src/infrastructure/email/ConflictCheckTaskSpec.ts:19,41`
- Modify: `packages/api/src/infrastructure/email/ReviewFeedbackTaskSpec.ts` (options + id line)
- Modify: `packages/api/src/infrastructure/connectors/github-repo-event/RepoScanTaskSpec.ts` (options + id line)
- Test: `packages/api/test/github-schedule-factories.test.js` (created in Task 3)

### Step 1: Write failing test — custom ID propagation

```javascript
// packages/api/test/github-schedule-factories.test.js (partial — ID propagation)
test('createCiCdCheckTaskSpec uses custom id when provided', () => {
  const spec = createCiCdCheckTaskSpec({
    taskStore: stubTaskStore,
    cicdRouter: stubCicdRouter,
    log: stubLog,
    id: 'schedule:github:cicd-check',
  });
  assert.strictEqual(spec.id, 'schedule:github:cicd-check');
});

test('createCiCdCheckTaskSpec defaults to cicd-check when id omitted', () => {
  const spec = createCiCdCheckTaskSpec({
    taskStore: stubTaskStore,
    cicdRouter: stubCicdRouter,
    log: stubLog,
  });
  assert.strictEqual(spec.id, 'cicd-check');
});
```

### Step 2: Run test, confirm red

Run: `pnpm test -- --test-name-pattern="custom id" packages/api/test/github-schedule-factories.test.js`
Expected: FAIL — test file doesn't exist yet / `id` property not accepted

### Step 3: Implement — add `id?: string` to each factory

**CiCdCheckTaskSpec.ts:**
```typescript
// In CiCdCheckTaskSpecOptions, add:
readonly id?: string;

// In createCiCdCheckTaskSpec return, change:
id: opts.id ?? 'cicd-check',
```

**ConflictCheckTaskSpec.ts:**
```typescript
readonly id?: string;
// ...
id: opts.id ?? 'conflict-check',
```

**ReviewFeedbackTaskSpec.ts:**
```typescript
readonly id?: string;
// ...
id: opts.id ?? 'review-feedback',
```

**RepoScanTaskSpec.ts:**
```typescript
readonly id?: string;
// ...
id: opts.id ?? 'repo-scan',
```

### Step 4: Run test, confirm green

Run: `pnpm test -- --test-name-pattern="custom id" packages/api/test/github-schedule-factories.test.js`
Expected: PASS

### Step 5: Run existing tests, confirm no regression

Run: `pnpm test packages/api/test/`
Expected: All existing tests pass (they don't pass `id`, so default kicks in)

### Step 6: Commit

```bash
git add packages/api/src/infrastructure/email/CiCdCheckTaskSpec.ts \
       packages/api/src/infrastructure/email/ConflictCheckTaskSpec.ts \
       packages/api/src/infrastructure/email/ReviewFeedbackTaskSpec.ts \
       packages/api/src/infrastructure/connectors/github-repo-event/RepoScanTaskSpec.ts
git commit -m "feat(F220-B): add optional id parameter to 4 GitHub TaskSpec factories

Backward-compatible: defaults to existing hardcoded IDs when omitted.
Schedule factories need to pass plugin-scoped instanceId."
```

---

## Task 2: Create `plugins/github/plugin.yaml`

Declare GitHub as a proper plugin with config fields and 4 schedule resources.

**Files:**
- Create: `plugins/github/plugin.yaml`
- Test: `packages/api/test/github-schedule-factories.test.js` (manifest parse test)

### Step 1: Write failing test — manifest parses correctly

```javascript
test('plugins/github/plugin.yaml parses as valid PluginManifest', () => {
  const yamlPath = join(__dirname, '../../plugins/github/plugin.yaml');
  const manifest = parsePluginManifest(yamlPath);
  assert.strictEqual(manifest.id, 'github');
  assert.strictEqual(manifest.config.length, 3);
  assert.strictEqual(manifest.resources.length, 4);
  // All resources are schedule type with factoryId
  for (const r of manifest.resources) {
    assert.strictEqual(r.type, 'schedule');
    assert.ok(r.factoryId?.startsWith('github.'));
    assert.ok(r.name);
  }
});
```

### Step 2: Run test, confirm red

Expected: FAIL — file not found

### Step 3: Create `plugins/github/plugin.yaml`

```yaml
id: github
name: GitHub
version: 1.0.0
description: "GitHub PR tracking, CI/CD monitoring, conflict detection, and repository scanning"
icon: github
builtin: true
docsUrl: "https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens"
setupSteps:
  - "Create a GitHub Personal Access Token (needs repo + notifications permissions)"
  - "Fill in the token to enable PR Tracking, Review Router, CI/CD Monitor"
  - "Optional: configure Noise Bot list to reduce setup-only comment noise"

config:
  - envName: GITHUB_TOKEN
    label: "Personal Access Token"
    sensitive: true
    required: true
  - envName: GITHUB_SETUP_NOISE_BOT_LOGINS
    label: "Noise Bot Login List"
    sensitive: false
    required: false
  - envName: GITHUB_MCP_PAT
    label: "MCP Token"
    sensitive: true
    required: false

resources:
  - type: schedule
    name: cicd-check
    factoryId: github.cicd-check
  - type: schedule
    name: conflict-check
    factoryId: github.conflict-check
  - type: schedule
    name: review-feedback
    factoryId: github.review-feedback
  - type: schedule
    name: repo-scan
    factoryId: github.repo-scan
```

### Step 4: Run test, confirm green

Expected: PASS — parser accepts the manifest

### Step 5: Commit

```bash
git add plugins/github/plugin.yaml packages/api/test/github-schedule-factories.test.js
git commit -m "feat(F220-B): create plugins/github/plugin.yaml

AC-B1: Declares 3 config fields (GITHUB_TOKEN, NOISE_BOT_LOGINS, MCP_PAT)
and 4 schedule resources referencing github.* factoryIds."
```

---

## Task 3: Create GitHub Schedule Factories

Implement 4 `ScheduleFactory` wrappers that extract typed deps and delegate to existing `createXxxTaskSpec` functions.

**Files:**
- Create: `packages/api/src/domains/plugin/github-schedule-factories.ts`
- Test: `packages/api/test/github-schedule-factories.test.js`

### Step 1: Write failing tests — factory registration + task creation

```javascript
test('registerGitHubScheduleFactories registers all 4 factories', () => {
  const registry = new ScheduleFactoryRegistry();
  registerGitHubScheduleFactories(registry);
  assert.ok(registry.has('github.cicd-check'));
  assert.ok(registry.has('github.conflict-check'));
  assert.ok(registry.has('github.review-feedback'));
  assert.ok(registry.has('github.repo-scan'));
});

test('github.cicd-check factory creates TaskSpec with correct instanceId', () => {
  const registry = new ScheduleFactoryRegistry();
  registerGitHubScheduleFactories(registry);
  const factory = registry.get('github.cicd-check');
  const deps = makeGitHubDeps();
  const spec = factory.createTaskSpec('schedule:github:cicd-check', deps);
  assert.strictEqual(spec.id, 'schedule:github:cicd-check');
  assert.strictEqual(spec.profile, 'poller');
});

test('github.repo-scan factory throws when redis deps missing', () => {
  const registry = new ScheduleFactoryRegistry();
  registerGitHubScheduleFactories(registry);
  const factory = registry.get('github.repo-scan');
  const deps = makeGitHubDeps();
  // Remove repo-scan required deps
  delete deps.repoAllowlist;
  assert.throws(() => factory.createTaskSpec('schedule:github:repo-scan', deps),
    /repo-scan requires repoAllowlist/);
});
```

### Step 2: Run test, confirm red

Expected: FAIL — `registerGitHubScheduleFactories` not found

### Step 3: Implement `github-schedule-factories.ts`

```typescript
// packages/api/src/domains/plugin/github-schedule-factories.ts
import type { ITaskStore } from '../../domains/cats/services/stores/ports/TaskStore.js';
import type { CiCdRouter } from '../../infrastructure/email/CiCdRouter.js';
import { createCiCdCheckTaskSpec } from '../../infrastructure/email/CiCdCheckTaskSpec.js';
import type { ConflictRouter } from '../../infrastructure/email/ConflictRouter.js';
import { createConflictCheckTaskSpec } from '../../infrastructure/email/ConflictCheckTaskSpec.js';
import type { ReviewFeedbackRouter } from '../../infrastructure/email/ReviewFeedbackRouter.js';
import { createReviewFeedbackTaskSpec } from '../../infrastructure/email/ReviewFeedbackTaskSpec.js';
import { createRepoScanTaskSpec } from '../../infrastructure/connectors/github-repo-event/RepoScanTaskSpec.js';
import type { ScheduleFactory, ScheduleFactoryDeps, ScheduleFactoryRegistry } from './ScheduleFactoryRegistry.js';

/** Typed dep extraction interface for GitHub schedule factories */
export interface GitHubScheduleDeps extends ScheduleFactoryDeps {
  taskStore: ITaskStore;
  cicdRouter: CiCdRouter;
  conflictRouter: ConflictRouter;
  reviewFeedbackRouter: ReviewFeedbackRouter;
  invokeTrigger: ConnectorInvokeTrigger;
  checkMergeable: (...) => Promise<...>;
  autoExecutor: ConflictAutoExecutor;
  // ... (all typed deps from terminal schema above)
}

const cicdCheckFactory: ScheduleFactory = {
  factoryId: 'github.cicd-check',
  createTaskSpec(instanceId, deps) {
    const d = deps as GitHubScheduleDeps;
    return createCiCdCheckTaskSpec({
      id: instanceId,
      taskStore: d.taskStore,
      cicdRouter: d.cicdRouter,
      invokeTrigger: d.invokeTrigger,
      log: d.log as CiCdCheckTaskSpecOptions['log'],
    });
  },
};

// ... conflict-check, review-feedback, repo-scan factories (same pattern)

export function registerGitHubScheduleFactories(registry: ScheduleFactoryRegistry): void {
  registry.register(cicdCheckFactory);
  registry.register(conflictCheckFactory);
  registry.register(reviewFeedbackFactory);
  registry.register(repoScanFactory);
}
```

### Step 4: Run test, confirm green

Run: `pnpm test packages/api/test/github-schedule-factories.test.js`
Expected: PASS

### Step 5: Run full backend tests

Run: `pnpm test packages/api/test/`
Expected: All pass

### Step 6: Commit

```bash
git add packages/api/src/domains/plugin/github-schedule-factories.ts \
       packages/api/test/github-schedule-factories.test.js
git commit -m "feat(F220-B): implement 4 GitHub schedule factories

Each factory wraps an existing createXxxTaskSpec function, extracting typed
deps from ScheduleFactoryDeps bag and passing plugin-scoped instanceId.
repo-scan factory validates required redis deps before construction."
```

---

## Task 4: Wire Factory Registration + Build Deps Bag in `index.ts`

Register GitHub factories in ScheduleFactoryRegistry and assemble the deps bag. Remove hardcoded task registrations.

**Files:**
- Modify: `packages/api/src/index.ts:2635-2841` (remove hardcoded block, add factory registration + deps)
- Test: `packages/api/test/github-schedule-factories.test.js` (integration test)

### Step 1: Write failing test — end-to-end enable/disable lifecycle

```javascript
test('GitHub plugin enable → 4 schedule tasks registered; disable → unregistered', async () => {
  // Uses full PluginResourceActivator with GitHub factories registered
  const registry = new ScheduleFactoryRegistry();
  registerGitHubScheduleFactories(registry);
  const taskRunner = makeTaskRunner();
  const activator = createActivator({ scheduleFactoryRegistry: registry, taskRunner, scheduleFactoryDeps: makeGitHubDeps() });
  
  const manifest = parsePluginManifest(join(__dirname, '../../plugins/github/plugin.yaml'));
  const result = await activator.enablePlugin(manifest);
  
  assert.strictEqual(result.status, 'success');
  assert.strictEqual(taskRunner.registered.length, 4);
  
  // Verify task IDs follow schedule:pluginId:name pattern
  const ids = taskRunner.registered.map(t => t.id).sort();
  assert.deepStrictEqual(ids, [
    'schedule:github:cicd-check',
    'schedule:github:conflict-check',
    'schedule:github:repo-scan',
    'schedule:github:review-feedback',
  ]);
  
  // Disable → all 4 unregistered
  await activator.disablePlugin(manifest);
  assert.strictEqual(taskRunner.unregistered.length, 4);
});
```

### Step 2: Run test, confirm red

Expected: FAIL until deps bag wired properly

### Step 3: Implement — modify `index.ts`

**Remove** the hardcoded registration block (lines ~2635-2841) and replace with:

```typescript
// F220 Phase B: Register GitHub schedule factories
import { registerGitHubScheduleFactories } from './domains/plugin/github-schedule-factories.js';
registerGitHubScheduleFactories(scheduleFactoryRegistry);

// Build GitHub schedule factory deps bag
// (helper functions stay here — they use services created in this scope)
const checkMergeable = async (repo: string, pr: number) => { /* ... existing inline ... */ };
const fetchPrMetadata = async (repo: string, pr: number) => { /* ... existing inline ... */ };
// ... etc

const githubScheduleDeps: ScheduleFactoryDeps = {
  log: app.log,
  taskStore,
  cicdRouter,
  conflictRouter,
  reviewFeedbackRouter,
  invokeTrigger,
  checkMergeable,
  autoExecutor,
  fetchPrMetadata,
  fetchComments: async (repo, pr, sinceId) => { /* ... existing ... */ },
  fetchReviews: async (repo, pr, sinceId) => { /* ... existing ... */ },
  isEchoComment: (c) => feedbackFilter.shouldSkipComment(c),
  isEchoReview: (r) => feedbackFilter.shouldSkipReview(r),
  isNoiseComment: setupNoiseFilter,
  // repo-scan deps (conditional)
  ...(ghRepoAllowlist && ghInboxCatId && redisClient ? {
    repoAllowlist: ghRepoAllowlist.split(',').map(r => r.trim()),
    inboxCatId: ghInboxCatId,
    defaultUserId: effectiveUserId,
    reconciliationDedup,
    bindingStore: new RedisConnectorThreadBindingStore(redisClient),
    deliverFn: deliverConnectorMessage,
    deliveryDeps: { messageStore, socketManager },
    fetchOpenPRs,
    fetchOpenIssues,
  } : {}),
};

// Pass deps to PluginResourceActivator
// (already wired via deps.scheduleFactoryDeps in activator construction)
```

**Key invariant:** The routers (cicdRouter, conflictRouter, reviewFeedbackRouter) and services (taskStore, invokeTrigger) are created BEFORE this block — their creation stays unchanged.

### Step 4: Run test, confirm green

### Step 5: Run full backend tests

Run: `pnpm test packages/api/test/`
Expected: All pass

### Step 6: Commit

```bash
git add packages/api/src/index.ts
git commit -m "feat(F220-B): wire GitHub factories in index.ts, remove hardcoded registrations

AC-B3: No more hardcoded GitHub task registration in index.ts.
Factory deps bag assembled from existing services in index.ts scope.
Poller logic untouched (KD-7)."
```

---

## Task 5: Remove GitHub from Connector Hub

Remove the GitHub platform definition from `CONNECTOR_PLATFORMS`. Config now flows through plugin-config-store.

**Files:**
- Modify: `packages/api/src/routes/connector-hub.ts:264-287`
- Test: existing connector-hub tests

### Step 1: Write failing test

```javascript
test('CONNECTOR_PLATFORMS does not include github', () => {
  const ids = CONNECTOR_PLATFORMS.map(p => p.id);
  assert.ok(!ids.includes('github'), 'GitHub should not be in CONNECTOR_PLATFORMS');
});
```

### Step 2: Run test, confirm red

### Step 3: Remove GitHub entry from CONNECTOR_PLATFORMS

Delete lines 263-286 (the `{ id: 'github', ... }` object from the array).

### Step 4: Run test, confirm green

### Step 5: Check for broken references

Grep for `connector/status` usage that specifically reads GitHub fields — may need updates in tests.

### Step 6: Run full tests

### Step 7: Commit

```bash
git add packages/api/src/routes/connector-hub.ts
git commit -m "feat(F220-B): remove GitHub from connector-hub CONNECTOR_PLATFORMS

AC-B5: GitHub config now managed by plugin-config-store.
Other platforms (feishu, weixin) unaffected."
```

---

## Task 6: Update Frontend — Remove GithubConfigPanel Special Case

Remove the `GithubConfigPanel` special case from `PluginsContent.tsx`. Once GitHub is a real plugin, `PluginConfigPanel` handles it generically.

**Files:**
- Modify: `packages/web/src/components/settings/PluginsContent.tsx:136-140`
- Modify: `packages/web/src/components/settings/GithubConfigPanel.tsx` (keep file, remove connector-hub dependency)
- Modify: `packages/web/src/components/settings/__tests__/GithubConfigPanel.test.ts`
- Test: `packages/web/src/components/__tests__/plugins-content-status.test.ts`

### Step 1: Modify PluginsContent.tsx

Remove the ternary that special-cases `plugin.id === 'github'`:

```typescript
// Before:
{isExpanded &&
  (plugin.id === 'github' ? (
    <GithubConfigPanel />
  ) : (
    <PluginConfigPanel plugin={plugin} onUpdated={fetchPlugins} />
  ))}

// After:
{isExpanded && (
  <PluginConfigPanel plugin={plugin} onUpdated={fetchPlugins} />
)}
```

### Step 2: Remove GithubConfigPanel import from PluginsContent.tsx

### Step 3: Update or remove GithubConfigPanel tests

The `GithubConfigPanel.test.ts` tests connector-hub API calls. After migration:
- Option A: Delete the test file (component no longer used)
- Option B: Keep the component but update to use plugin API

Decision: Delete the component and test — PluginConfigPanel covers the use case.

### Step 4: Update plugins-content tests

If any test references `GithubConfigPanel` or expects the special case, update.

### Step 5: Run frontend tests

Run: `pnpm test packages/web/`
Expected: All pass

### Step 6: Commit

```bash
git add packages/web/src/components/settings/PluginsContent.tsx \
       packages/web/src/components/settings/GithubConfigPanel.tsx
git commit -m "feat(F220-B): remove GithubConfigPanel special case

AC-B6: GitHub config now handled by generic PluginConfigPanel.
Connector-hub API no longer needed for GitHub configuration."
```

---

## Task 7: Integration Test — Full Enable/Disable Lifecycle

Verify AC-B4 end-to-end: enable GitHub plugin → 4 pollers register; disable → all unregister.

**Files:**
- Modify: `packages/api/test/github-schedule-factories.test.js`

### Step 1: Write integration test

```javascript
describe('GitHub plugin lifecycle (AC-B4)', () => {
  test('enable → 4 schedule tasks active; disable → 0 active', async () => {
    // Full activator with real ScheduleFactoryRegistry
    // Enable → check taskRunner.registered has 4 entries
    // Disable → check taskRunner.unregistered has 4 entries
    // Re-enable → idempotent, 4 new entries
  });

  test('rehydration restores 4 schedule tasks on startup', async () => {
    // Write capabilities.json with 4 enabled schedule entries
    // Call rehydrateEnabledPluginSchedules
    // Verify taskRunner has 4 registered tasks
  });

  test('existing pr_tracking tasks unaffected by plugin lifecycle (AC-B7)', async () => {
    // TaskStore has pr_tracking tasks
    // Enable/disable GitHub plugin
    // Verify pr_tracking tasks still in TaskStore
  });
});
```

### Step 2: Run tests, confirm green

### Step 3: Run full test suite

Run: `pnpm test`
Expected: All pass

### Step 4: Run lint + type check

Run: `pnpm check && pnpm lint`
Expected: Clean

### Step 5: Commit

```bash
git add packages/api/test/github-schedule-factories.test.js
git commit -m "test(F220-B): integration tests for GitHub plugin lifecycle

AC-B4: enable/disable toggles all 4 pollers.
AC-B7: pr_tracking tasks survive plugin lifecycle changes."
```

---

## Task 8: Quality Gate

### Step 1: Run full test suite

Run: `pnpm test`

### Step 2: Run biome + lint

Run: `pnpm check && pnpm lint`

### Step 3: AC Verification Checklist

| AC | Evidence |
|----|----------|
| AC-B1 | `plugins/github/plugin.yaml` exists with 3 config + 4 schedule resources |
| AC-B2 | `resolvePluginEnv` resolves GitHub config; no connector-hub dependency |
| AC-B3 | `grep -r "createCiCdCheckTaskSpec\|createConflictCheckTaskSpec\|createReviewFeedbackTaskSpec\|createRepoScanTaskSpec" packages/api/src/index.ts` returns 0 matches |
| AC-B4 | Integration test: enable → 4 registered, disable → 4 unregistered |
| AC-B5 | `grep "github" packages/api/src/routes/connector-hub.ts` returns 0 matches |
| AC-B6 | `PluginsContent.tsx` uses `PluginConfigPanel` for all plugins including GitHub |
| AC-B7 | Integration test: pr_tracking tasks survive enable/disable |

### Step 4: Commit and push

```bash
git push origin feat/f220-plugin-schedule-resource
```

---

## Open Questions

### Technical OQs (resolve during implementation)

1. **`ScheduleFactoryDeps` log type narrowing**: GitHub TaskSpec factories expect `{ info, error, warn }` but `ScheduleFactoryDeps.log` only declares `{ info, error }`. Solution: either extend the base type or cast in factory.

2. **`PluginConfigField` lacks `defaultValue` / `restartRequired`**: The connector-hub had these for `GITHUB_SETUP_NOISE_BOT_LOGINS`. After migration, the default value won't be shown as placeholder in the UI. Acceptable for Phase B — can be enhanced later.

3. **Existing `capabilities.json` may have no GitHub entries**: First-time plugin enable requires user action (or auto-enable logic for `builtin: true` plugins). Check if `PluginRegistry` auto-discovers `builtin` plugins.

4. **GitHub MCP PAT**: `GITHUB_MCP_PAT` is used by the GitHub MCP server, not the pollers. It's config-only — no schedule resource needed. Verify it resolves correctly through `resolvePluginEnv` after migration.

5. **`f190-visual-contract.test.ts` references `GithubConfigPanel.tsx`**: Line 459 — needs update if we delete the component file.
