// @ts-check
/**
 * F220 Phase B: GitHub Schedule Factories — unit + integration tests
 *
 * Covers:
 * - plugin.yaml manifest parsing (AC-B1)
 * - Factory registration + task creation with custom instanceId
 * - repo-scan missing deps validation
 * - Full enable/disable lifecycle via PluginResourceActivator (AC-B4)
 * - Rehydration of GitHub schedule resources on startup (AC-B4)
 * - Custom ID propagation to existing TaskSpec factories
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Phase A imports
import { ScheduleFactoryRegistry } from '../dist/domains/plugin/ScheduleFactoryRegistry.js';

// Phase B imports
import { registerGitHubScheduleFactories } from '../dist/domains/plugin/github-schedule-factories.js';

// Manifest parser
import { parsePluginManifest } from '../dist/domains/plugin/plugin-manifest.js';

// TaskSpec factories (for custom id tests)
import { createCiCdCheckTaskSpec } from '../dist/infrastructure/email/CiCdCheckTaskSpec.js';
import { createConflictCheckTaskSpec } from '../dist/infrastructure/email/ConflictCheckTaskSpec.js';
import { createReviewFeedbackTaskSpec } from '../dist/infrastructure/email/ReviewFeedbackTaskSpec.js';
import { createRepoScanTaskSpec } from '../dist/infrastructure/connectors/github-repo-event/RepoScanTaskSpec.js';

const stubLog = {
  info: () => {},
  error: () => {},
  warn: () => {},
};

const stubTaskStore = {
  listByKind: async () => [],
  patchAutomationState: async () => {},
};

const stubRouter = { route: async () => ({ kind: 'skipped' }) };

/** Minimal ScheduleFactoryDeps bag for GitHub factories */
function makeGitHubDeps(overrides = {}) {
  return {
    log: stubLog,
    taskStore: stubTaskStore,
    cicdRouter: stubRouter,
    conflictRouter: stubRouter,
    reviewFeedbackRouter: stubRouter,
    invokeTrigger: { trigger: () => 'dispatched' },
    checkMergeable: async () => ({ mergeState: 'MERGEABLE', headSha: 'abc123' }),
    autoExecutor: { execute: async () => {} },
    fetchPrMetadata: async () => ({ headSha: 'abc', prState: 'open' }),
    fetchComments: async () => [],
    fetchReviews: async () => [],
    isEchoComment: () => false,
    isEchoReview: () => false,
    isNoiseComment: () => false,
    // repo-scan deps
    repoAllowlist: ['owner/repo'],
    inboxCatId: 'cat-1',
    defaultUserId: 'user-1',
    reconciliationDedup: {
      isNotified: async () => false,
      markNotified: async () => {},
      isBaselineEstablished: async () => true,
      markBaselineEstablished: async () => {},
    },
    bindingStore: { getByExternal: async () => null },
    deliverFn: async () => ({ status: 'delivered', threadId: 't1' }),
    deliveryDeps: { messageStore: {}, socketManager: {} },
    fetchOpenPRs: async () => [],
    fetchOpenIssues: async () => [],
    ...overrides,
  };
}

// --- Task 1: Custom ID propagation ---

describe('TaskSpec factory custom id (F220-B Task 1)', () => {
  test('createCiCdCheckTaskSpec uses custom id when provided', () => {
    const spec = createCiCdCheckTaskSpec({
      taskStore: stubTaskStore,
      cicdRouter: stubRouter,
      log: stubLog,
      id: 'schedule:github:cicd-check',
    });
    assert.strictEqual(spec.id, 'schedule:github:cicd-check');
  });

  test('createCiCdCheckTaskSpec defaults to cicd-check when id omitted', () => {
    const spec = createCiCdCheckTaskSpec({
      taskStore: stubTaskStore,
      cicdRouter: stubRouter,
      log: stubLog,
    });
    assert.strictEqual(spec.id, 'cicd-check');
  });

  test('createConflictCheckTaskSpec uses custom id when provided', () => {
    const spec = createConflictCheckTaskSpec({
      taskStore: stubTaskStore,
      checkMergeable: async () => ({ mergeState: 'MERGEABLE', headSha: 'abc' }),
      conflictRouter: stubRouter,
      log: stubLog,
      id: 'schedule:github:conflict-check',
    });
    assert.strictEqual(spec.id, 'schedule:github:conflict-check');
  });

  test('createReviewFeedbackTaskSpec uses custom id when provided', () => {
    const spec = createReviewFeedbackTaskSpec({
      taskStore: stubTaskStore,
      fetchComments: async () => [],
      fetchReviews: async () => [],
      reviewFeedbackRouter: stubRouter,
      log: stubLog,
      id: 'schedule:github:review-feedback',
    });
    assert.strictEqual(spec.id, 'schedule:github:review-feedback');
  });

  test('createRepoScanTaskSpec uses custom id when provided', () => {
    const spec = createRepoScanTaskSpec({
      repoAllowlist: ['owner/repo'],
      inboxCatId: 'cat-1',
      defaultUserId: 'user-1',
      reconciliationDedup: {
        isNotified: async () => false,
        markNotified: async () => {},
        isBaselineEstablished: async () => true,
        markBaselineEstablished: async () => {},
      },
      bindingStore: { getByExternal: async () => null },
      deliverFn: async () => ({ status: 'delivered', threadId: 't1' }),
      deliveryDeps: { messageStore: {}, socketManager: {} },
      invokeTrigger: { trigger: () => {} },
      fetchOpenPRs: async () => [],
      fetchOpenIssues: async () => [],
      log: stubLog,
      id: 'schedule:github:repo-scan',
    });
    assert.strictEqual(spec.id, 'schedule:github:repo-scan');
  });
});

// --- Task 2: plugin.yaml manifest parsing ---

describe('plugins/github/plugin.yaml (AC-B1)', () => {
  test('parses as valid PluginManifest with 3 config + 4 schedule resources', () => {
    const yamlPath = join(__dirname, '../../../plugins/github/plugin.yaml');
    assert.ok(existsSync(yamlPath), `plugin.yaml must exist at ${yamlPath}`);

    const manifest = parsePluginManifest(yamlPath);
    assert.strictEqual(manifest.id, 'github');
    assert.strictEqual(manifest.name, 'GitHub');
    assert.strictEqual(manifest.version, '1.0.0');

    // Config fields
    assert.strictEqual(manifest.config.length, 3);
    const envNames = manifest.config.map((c) => c.envName);
    assert.ok(envNames.includes('GITHUB_TOKEN'));
    assert.ok(envNames.includes('GITHUB_SETUP_NOISE_BOT_LOGINS'));
    assert.ok(envNames.includes('GITHUB_MCP_PAT'));

    // Token is required, others optional
    const tokenField = manifest.config.find((c) => c.envName === 'GITHUB_TOKEN');
    assert.strictEqual(tokenField?.required, true);
    assert.strictEqual(tokenField?.sensitive, true);

    const noiseField = manifest.config.find((c) => c.envName === 'GITHUB_SETUP_NOISE_BOT_LOGINS');
    assert.strictEqual(noiseField?.required, false);

    // Schedule resources
    assert.strictEqual(manifest.resources.length, 4);
    for (const r of manifest.resources) {
      assert.strictEqual(r.type, 'schedule');
      assert.ok(r.factoryId?.startsWith('github.'), `factoryId must start with "github.": ${r.factoryId}`);
      assert.ok(r.name, `schedule resource must have a name`);
    }

    const resourceNames = manifest.resources.map((r) => r.name).sort();
    assert.deepStrictEqual(resourceNames, ['cicd-check', 'conflict-check', 'repo-scan', 'review-feedback']);
  });
});

// --- Task 3: Factory registration + task creation ---

describe('GitHub schedule factory registration (F220-B Task 3)', () => {
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
    assert.ok(factory);
    const spec = factory.createTaskSpec('schedule:github:cicd-check', makeGitHubDeps());
    assert.strictEqual(spec.id, 'schedule:github:cicd-check');
    assert.strictEqual(spec.profile, 'poller');
  });

  test('github.conflict-check factory creates TaskSpec with correct instanceId', () => {
    const registry = new ScheduleFactoryRegistry();
    registerGitHubScheduleFactories(registry);
    const factory = registry.get('github.conflict-check');
    assert.ok(factory);
    const spec = factory.createTaskSpec('schedule:github:conflict-check', makeGitHubDeps());
    assert.strictEqual(spec.id, 'schedule:github:conflict-check');
    assert.strictEqual(spec.profile, 'poller');
  });

  test('github.review-feedback factory creates TaskSpec with correct instanceId', () => {
    const registry = new ScheduleFactoryRegistry();
    registerGitHubScheduleFactories(registry);
    const factory = registry.get('github.review-feedback');
    assert.ok(factory);
    const spec = factory.createTaskSpec('schedule:github:review-feedback', makeGitHubDeps());
    assert.strictEqual(spec.id, 'schedule:github:review-feedback');
    assert.strictEqual(spec.profile, 'poller');
  });

  test('github.repo-scan factory creates TaskSpec with correct instanceId', () => {
    const registry = new ScheduleFactoryRegistry();
    registerGitHubScheduleFactories(registry);
    const factory = registry.get('github.repo-scan');
    assert.ok(factory);
    const spec = factory.createTaskSpec('schedule:github:repo-scan', makeGitHubDeps());
    assert.strictEqual(spec.id, 'schedule:github:repo-scan');
    assert.strictEqual(spec.profile, 'poller');
  });

  test('github.repo-scan factory throws when repoAllowlist missing', () => {
    const registry = new ScheduleFactoryRegistry();
    registerGitHubScheduleFactories(registry);
    const factory = registry.get('github.repo-scan');
    assert.ok(factory);
    const deps = makeGitHubDeps({ repoAllowlist: undefined });
    assert.throws(
      () => factory.createTaskSpec('schedule:github:repo-scan', deps),
      /repoAllowlist/,
    );
  });

  test('github.repo-scan factory throws when redis deps missing', () => {
    const registry = new ScheduleFactoryRegistry();
    registerGitHubScheduleFactories(registry);
    const factory = registry.get('github.repo-scan');
    assert.ok(factory);
    const deps = makeGitHubDeps({ reconciliationDedup: undefined });
    assert.throws(
      () => factory.createTaskSpec('schedule:github:repo-scan', deps),
      /reconciliationDedup/,
    );
  });

  test('asGitHub validates taskStore presence', () => {
    const registry = new ScheduleFactoryRegistry();
    registerGitHubScheduleFactories(registry);
    const factory = registry.get('github.cicd-check');
    assert.ok(factory);
    assert.throws(
      () => factory.createTaskSpec('schedule:github:cicd-check', { log: stubLog }),
      /taskStore/,
    );
  });
});

// --- Task 4+7: Integration — enable/disable lifecycle (AC-B4) ---

describe('GitHub plugin lifecycle (AC-B4)', () => {
  // Helper: create a PluginResourceActivator with GitHub factories
  function makeTaskRunner() {
    const registered = [];
    const unregistered = [];
    const live = new Set();
    return {
      registered,
      unregistered,
      registerPostStart(task) {
        if (live.has(task.id)) throw new Error(`TaskRunnerV2: duplicate task id "${task.id}"`);
        registered.push(task);
        live.add(task.id);
      },
      unregister(taskId) {
        if (!live.has(taskId)) return false;
        live.delete(taskId);
        unregistered.push(taskId);
        return true;
      },
      register(task) {
        registered.push(task);
        live.add(task.id);
      },
    };
  }

  function createTempDir() {
    const dir = join(__dirname, `tmp-github-lifecycle-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(dir, 'plugins', 'github'), { recursive: true });
    return dir;
  }

  function writeCapabilities(dir, caps) {
    const capDir = join(dir, '.cat-cafe');
    mkdirSync(capDir, { recursive: true });
    writeFileSync(join(capDir, 'capabilities.json'), JSON.stringify(caps));
  }

  function readCapabilities(dir) {
    const p = join(dir, '.cat-cafe', 'capabilities.json');
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, 'utf-8'));
  }

  test('enable → 4 schedule tasks registered; disable → 4 unregistered', async () => {
    const tmpDir = createTempDir();
    try {
      // Setup
      const registry = new ScheduleFactoryRegistry();
      registerGitHubScheduleFactories(registry);
      const taskRunner = makeTaskRunner();
      writeCapabilities(tmpDir, { capabilities: [] });

      const { PluginResourceActivator } = await import('../dist/domains/plugin/PluginResourceActivator.js');
      const activator = new PluginResourceActivator({
        resolveProjectRoot: () => tmpDir,
        pluginsDir: join(tmpDir, 'plugins'),
        limbRegistry: { register: () => {}, unregister: () => {}, getNode: () => null },
        readCapabilities: async () => readCapabilities(tmpDir),
        writeCapabilities: async (cfg) => writeCapabilities(tmpDir, cfg),
        withCapabilityLock: async (fn) => fn(),
        scheduleFactoryRegistry: registry,
        taskRunner,
        scheduleFactoryDeps: makeGitHubDeps(),
      });

      const manifest = parsePluginManifest(join(__dirname, '../../../plugins/github/plugin.yaml'));
      const result = await activator.enablePlugin(manifest);

      // All 4 schedule resources should succeed
      assert.strictEqual(result.status, 'success', `enable should succeed: ${JSON.stringify(result)}`);
      assert.strictEqual(result.resources.length, 4);
      for (const r of result.resources) {
        assert.ok(r.ok, `resource ${r.name} should be ok: ${r.error}`);
      }

      // TaskRunner should have 4 registered tasks
      assert.strictEqual(taskRunner.registered.length, 4);
      const ids = taskRunner.registered.map((t) => t.id).sort();
      assert.deepStrictEqual(ids, [
        'schedule:github:cicd-check',
        'schedule:github:conflict-check',
        'schedule:github:repo-scan',
        'schedule:github:review-feedback',
      ]);

      // Disable → all 4 unregistered
      await activator.disablePlugin(manifest);
      assert.strictEqual(taskRunner.unregistered.length, 4);
      const unregIds = [...taskRunner.unregistered].sort();
      assert.deepStrictEqual(unregIds, ids);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('enable with missing repo-scan deps → 3 succeed, 1 fails gracefully', async () => {
    const tmpDir = createTempDir();
    try {
      const registry = new ScheduleFactoryRegistry();
      registerGitHubScheduleFactories(registry);
      const taskRunner = makeTaskRunner();
      writeCapabilities(tmpDir, { capabilities: [] });

      const { PluginResourceActivator } = await import('../dist/domains/plugin/PluginResourceActivator.js');
      // Remove repo-scan deps to simulate no redis
      const deps = makeGitHubDeps({ repoAllowlist: undefined, reconciliationDedup: undefined });
      const activator = new PluginResourceActivator({
        resolveProjectRoot: () => tmpDir,
        pluginsDir: join(tmpDir, 'plugins'),
        limbRegistry: { register: () => {}, unregister: () => {}, getNode: () => null },
        readCapabilities: async () => readCapabilities(tmpDir),
        writeCapabilities: async (cfg) => writeCapabilities(tmpDir, cfg),
        withCapabilityLock: async (fn) => fn(),
        scheduleFactoryRegistry: registry,
        taskRunner,
        scheduleFactoryDeps: deps,
      });

      const manifest = parsePluginManifest(join(__dirname, '../../../plugins/github/plugin.yaml'));
      const result = await activator.enablePlugin(manifest);

      // 3 succeed, 1 fails (repo-scan)
      assert.strictEqual(result.status, 'partial');
      const succeeded = result.resources.filter((r) => r.ok);
      const failed = result.resources.filter((r) => !r.ok);
      assert.strictEqual(succeeded.length, 3);
      assert.strictEqual(failed.length, 1);
      assert.strictEqual(failed[0].name, 'repo-scan');
      assert.ok(failed[0].error?.includes('repoAllowlist'));

      // Only 3 tasks registered
      assert.strictEqual(taskRunner.registered.length, 3);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
