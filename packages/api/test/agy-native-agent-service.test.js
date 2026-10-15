import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

const { AgyNativeAgentService } = await import(
  '../dist/domains/cats/services/agents/providers/agy-native/AgyNativeAgentService.js'
);

function fixture(
  l0CompilerFn = async () => '# Identity\nYou are F325-TEST-CAT.\n',
  profilePatch = {},
  servicePatch = {},
) {
  const base = mkdtempSync(join(tmpdir(), 'f325-agy-service-'));
  const workspace = join(base, 'workspace');
  mkdirSync(join(workspace, 'src'), { recursive: true });
  const service = new AgyNativeAgentService({
    catId: 'gemini38',
    profile: {
      enabled: true,
      profileId: 'gemini38',
      homeRoot: join(base, 'profiles'),
      model: 'gemini-3.8-flash-high',
      trustedWorkspaces: [workspace],
      ...profilePatch,
    },
    command: '/usr/bin/true',
    l0CompilerFn,
    ...servicePatch,
  });
  return { base, workspace, service, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

function fakeEvents(agentName, cwd, conversationId, response, deniedActions = []) {
  return [
    {
      event: 'init',
      conversation_id: conversationId,
      init: { cwd, agent: agentName, model: 'gemini-3.8-flash-high', permission_mode: 'request-review', tools: [] },
    },
    {
      event: 'result',
      result: {
        conversation_id: conversationId,
        status: 'SUCCESS',
        response,
        denied_actions: deniedActions,
        num_turns: 1,
      },
    },
  ];
}

async function collect(iterable) {
  const values = [];
  for await (const value of iterable) values.push(value);
  return values;
}

describe('F325 one-turn native AGY carrier', () => {
  test('normal MCP discovery uses project capabilities, identity env and per-turn credentials', async () => {
    const f = fixture();
    mkdirSync(join(f.workspace, '.cat-cafe'));
    writeFileSync(
      join(f.workspace, '.cat-cafe/capabilities.json'),
      JSON.stringify({
        version: 2,
        capabilities: [
          {
            id: 'cat-cafe-memory',
            type: 'mcp',
            source: 'cat-cafe',
            enabled: true,
            mcpServer: { command: 'node', args: [] },
          },
          {
            id: 'cat-cafe-limb',
            type: 'mcp',
            source: 'cat-cafe',
            enabled: true,
            mcpServer: { command: 'node', args: [] },
          },
          {
            id: 'cat-cafe-finance',
            type: 'mcp',
            source: 'cat-cafe',
            blockedCats: ['gemini38'],
            mcpServer: { command: 'node', args: [] },
          },
          {
            id: 'project-fixture',
            type: 'mcp',
            source: 'external',
            enabled: true,
            mcpServer: { command: '/usr/bin/true', args: ['--fixture'] },
          },
        ],
      }),
    );
    let servers;
    let credential;
    try {
      const events = await collect(
        f.service.invoke('Use the tools enabled for this project.', {
          workingDirectory: f.workspace,
          callbackEnv: {
            CAT_CAFE_API_URL: 'http://127.0.0.1:3012',
            CAT_CAFE_INVOCATION_ID: 'discovery-inv',
            CAT_CAFE_CALLBACK_TOKEN: 'fixture-token',
            CAT_CAFE_CAT_ID: 'gemini38',
            CAT_CAFE_THREAD_ID: 'discovery-thread',
            CAT_CAFE_USER_ID: 'owner',
          },
          spawnCliOverride: async function* (launch) {
            servers = JSON.parse(
              readFileSync(join(launch.env.HOME, '.gemini/config/mcp_config.json'), 'utf8'),
            ).mcpServers;
            credential = servers['cat-cafe-memory']?.env.CAT_CAFE_CREDENTIAL_FILE;
            yield* fakeEvents(
              launch.args[launch.args.indexOf('--agent') + 1],
              launch.cwd,
              'discovery-session',
              'Done.',
            );
          },
        }),
      );
      assert.equal(events.at(-1).errorCode, undefined, JSON.stringify(events));
      assert.deepEqual(Object.keys(servers).sort(), ['cat-cafe-limb', 'cat-cafe-memory', 'project-fixture']);
      const env = servers['cat-cafe-memory'].env;
      assert.equal(env.CAT_CAFE_CAT_ID, 'gemini38');
      assert.equal(env.CAT_CAFE_THREAD_ID, 'discovery-thread');
      assert.equal(env.CAT_CAFE_USER_ID, 'owner');
      assert.equal(env.ALLOWED_WORKSPACE_DIRS, process.env.ALLOWED_WORKSPACE_DIRS?.trim() || f.workspace);
      assert.equal(env.CAT_CAFE_CALLBACK_TOKEN, undefined);
      assert.equal(env.CAT_CAFE_INVOCATION_ID, undefined);
      assert.equal(
        servers['project-fixture'].env,
        undefined,
        'external tools must not inherit host callback authority',
      );
      assert.ok(credential && !existsSync(credential), 'terminal cleanup retires the exact credential');
    } finally {
      f.cleanup();
    }
  });

  test('every normal native launch installs the host target guard before any tool can execute', async () => {
    for (const autoApprove of [false, true]) {
      const f = fixture(undefined, { autoApprove });
      let installed;
      try {
        const events = await collect(
          f.service.invoke('Do ordinary project work.', {
            workingDirectory: f.workspace,
            spawnCliOverride: async function* (launch) {
              const path = join(launch.env.HOME, '.gemini/config/hooks.json');
              installed = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
              const frames = fakeEvents(
                launch.args[launch.args.indexOf('--agent') + 1],
                launch.cwd,
                'guarded-session',
                'Done.',
              );
              frames[0].init.permission_mode = autoApprove ? 'always-proceed' : 'request-review';
              yield* frames;
            },
          }),
        );
        assert.equal(events.at(-1).errorCode, undefined);
        const group = installed?.['cat-cafe-native-effect']?.PreToolUse?.[0];
        assert.equal(group?.matcher, '*', 'the provider must not execute tools outside host guard observation');
        assert.match(group.hooks[0].command, /agy-native-effect-guard\.mjs/);
        assert.ok(group.hooks[0].timeout > 0);
      } finally {
        f.cleanup();
      }
    }
  });

  for (const [directory, name] of [
    ['.agents', 'hooks.json'],
    ['.agents', 'agents'],
    ['.agents', 'plugins'],
    ['.agents', 'skills.json'],
    ['.agents', 'mcp_config.json'],
    ['.Agents', 'MCP_CONFIG.JSON'],
  ]) {
    for (const withSensitiveFile of [false, true]) {
      test(`autoApprove refuses ${directory}/${name}${withSensitiveFile ? ' alongside .env' : ''} before spawn`, async () => {
        const f = fixture(undefined, { autoApprove: true });
        const customization = join(f.workspace, directory, name);
        mkdirSync(join(f.workspace, directory));
        if (['agents', 'plugins'].includes(name)) mkdirSync(customization);
        else writeFileSync(customization, '{}');
        if (withSensitiveFile) writeFileSync(join(f.workspace, '.env'), 'FIXTURE_ONLY=yes\n');
        let spawned = false;
        try {
          const events = await collect(
            f.service.invoke('Hello.', {
              workingDirectory: f.workspace,
              spawnCliOverride: async function* (launch) {
                spawned = true;
                const agent = launch.args[launch.args.indexOf('--agent') + 1];
                const frames = fakeEvents(agent, launch.cwd, 'unexpected-customized-session', 'Hello.');
                frames[0].init.permission_mode = 'always-proceed';
                yield* frames;
              },
            }),
          );
          assert.equal(spawned, false, JSON.stringify(events));
          assert.equal(events.at(-1).errorCode, 'AGY_WORKSPACE_CUSTOMIZATION');
          assert.ok(events.find((event) => event.type === 'error').error.includes(name));
        } finally {
          f.cleanup();
        }
      });
    }
  }

  test('explicit autoApprove launches a normal repository with official bypass mode and native commands', async () => {
    const f = fixture(undefined, { autoApprove: true, trustedWorkspaces: [] });
    writeFileSync(join(f.workspace, '.env'), 'FIXTURE_ONLY=yes\n');
    let launch;
    try {
      const events = await collect(
        f.service.invoke('Say hello.', {
          workingDirectory: f.workspace,
          spawnCliOverride: async function* (options) {
            launch = options;
            const agent = options.args[options.args.indexOf('--agent') + 1];
            const frames = fakeEvents(agent, options.cwd, 'auto-approved-session', 'Hello.');
            frames[0].init.permission_mode = 'always-proceed';
            yield* frames;
          },
        }),
      );
      assert.ok(launch, JSON.stringify(events));
      assert.ok(launch.args.includes('--dangerously-skip-permissions'));
      assert.ok(!launch.args.includes('--sandbox'));
      assert.equal(launch.inheritParentEnv, false);
      assert.equal(launch.env.CAT_CAFE_AGENT_KEY_SECRET, null);
      const agent = launch.args[launch.args.indexOf('--agent') + 1];
      const body = readFileSync(join(launch.env.HOME, '.gemini/config/agents', agent, 'agent.md'), 'utf8');
      assert.match(body, / {2}- run_command\n/);
      assert.ok(!body.includes('commandExecutionPolicy: off'));
      const settings = JSON.parse(readFileSync(join(launch.env.HOME, '.gemini/antigravity-cli/settings.json')));
      assert.equal(settings.toolPermission, 'always-proceed');
      assert.equal(settings.enableTerminalSandbox, false);
      assert.deepEqual(settings.permissions.deny, []);
      assert.equal(events.at(-1).errorCode, undefined, JSON.stringify(events));
    } finally {
      f.cleanup();
    }
  });

  test('permission changes require an explicit new session; matching durable bindings resume', async () => {
    const f = fixture(undefined, { autoApprove: true });
    const launches = [];
    const options = {
      workingDirectory: f.workspace,
      spawnCliOverride: async function* (launch) {
        launches.push(launch);
        const agent = launch.args[launch.args.indexOf('--agent') + 1];
        const resumeIndex = launch.args.indexOf('--conversation');
        const id = resumeIndex < 0 ? `mode-${launches.length}` : launch.args[resumeIndex + 1];
        const frames = fakeEvents(agent, launch.cwd, id, 'OK');
        frames[0].init.permission_mode = launch.args.includes('--dangerously-skip-permissions')
          ? 'always-proceed'
          : 'request-review';
        yield* frames;
      },
    };
    try {
      const first = await collect(f.service.invoke('Automatic.', options));
      assert.equal(first.at(-1).errorCode, undefined);
      const mismatch = await collect(
        f.service.invoke('Read only.', {
          ...options,
          sessionId: 'mode-1',
          nativeSessionBinding: first[0].nativeSessionBinding,
          toolExecutionPolicy: { mode: 'read_only' },
        }),
      );
      assert.equal(mismatch.at(-1).errorCode, 'AGY_NATIVE_RESUME_MISMATCH');
      assert.equal(launches.length, 1);
      const readonly = await collect(
        f.service.invoke('Read only.', {
          ...options,
          toolExecutionPolicy: { mode: 'read_only' },
        }),
      );
      assert.equal(readonly.at(-1).errorCode, undefined);
      assert.ok(launches[1].args.includes('--sandbox'));
      assert.ok(!launches[1].args.includes('--dangerously-skip-permissions'));
      assert.ok(!launches[1].args.includes('--conversation'), 'a permissive session cannot be resumed as read-only');
      const resumed = await collect(
        f.service.invoke('Read only again.', {
          ...options,
          sessionId: 'mode-2',
          nativeSessionBinding: readonly[0].nativeSessionBinding,
          toolExecutionPolicy: { mode: 'read_only' },
        }),
      );
      assert.equal(resumed.at(-1).errorCode, undefined);
      assert.ok(launches[2].args.includes('--conversation'), 'same-mode sessions still resume');
    } finally {
      f.cleanup();
    }
  });

  test('an automatic launch rejects a provider claiming the restricted permission mode', async () => {
    const f = fixture(undefined, { autoApprove: true });
    try {
      const events = await collect(
        f.service.invoke('Hello.', {
          workingDirectory: f.workspace,
          spawnCliOverride: async function* (launch) {
            const agent = launch.args[launch.args.indexOf('--agent') + 1];
            yield* fakeEvents(agent, launch.cwd, 'wrong-mode', 'OK');
          },
        }),
      );
      assert.equal(events.at(-1).errorCode, 'AGY_NATIVE_PREFLIGHT');
      assert.match(events.find((e) => e.type === 'error').error, /permission mode/);
    } finally {
      f.cleanup();
    }
  });

  test('read_only can enter an ordinary repository while keeping writes and MCP unavailable', async () => {
    const f = fixture(undefined, { autoApprove: true });
    writeFileSync(join(f.workspace, '.env'), 'FIXTURE_ONLY=yes');
    let launch;
    try {
      const events = await collect(
        f.service.invoke('Read only.', {
          workingDirectory: f.workspace,
          toolExecutionPolicy: { mode: 'read_only' },
          spawnCliOverride: async function* (options) {
            launch = options;
            yield* fakeEvents(
              options.args[options.args.indexOf('--agent') + 1],
              options.cwd,
              'read-only-session',
              'Read.',
            );
          },
        }),
      );
      assert.equal(events.at(-1).errorCode, undefined);
      assert.ok(launch.args.includes('--sandbox'));
      const settings = JSON.parse(readFileSync(join(launch.env.HOME, '.gemini/antigravity-cli/settings.json'), 'utf8'));
      assert.ok(settings.permissions.deny.includes('write_file(*)'));
      assert.ok(settings.permissions.deny.includes('mcp(*)'));
    } finally {
      f.cleanup();
    }
  });

  test('both successors queue without overlapping a canceled profile', async () => {
    const f = fixture();
    const controller = new AbortController();
    let releaseDrain, reportStarted;
    const drained = new Promise((resolve) => {
      releaseDrain = resolve;
    });
    const started = new Promise((resolve) => {
      reportStarted = resolve;
    });
    let launches = 0;
    const options = {
      workingDirectory: f.workspace,
      spawnCliOverride: async function* (launch) {
        launches++;
        const agent = launch.args[launch.args.indexOf('--agent') + 1];
        if (launches === 1) {
          reportStarted();
          await drained;
        }
        yield* fakeEvents(agent, launch.cwd, `exclusive-session-${launches}`, 'OK');
      },
    };
    let first, second, third;
    try {
      first = collect(f.service.invoke('Canceled holder.', { ...options, signal: controller.signal }));
      await started;
      controller.abort();
      second = collect(f.service.invoke('Successor A.', options));
      third = collect(f.service.invoke('Successor B.', options));
      await new Promise(setImmediate);
      assert.equal(launches, 1, 'neither successor may overlap the draining holder');
      releaseDrain();
      const [oldEvents, ...nextEvents] = await Promise.all([first, second, third]);
      assert.equal(oldEvents.at(-1).errorCode, 'AGY_CANCELLED');
      assert.equal(launches, 3, 'both successors run after the holder releases');
      assert.equal(nextEvents.filter((events) => events.at(-1).errorCode === undefined).length, 2);
    } finally {
      releaseDrain();
      await Promise.allSettled([first, second, third]);
      f.cleanup();
    }
  });

  test('waits for a canceled native profile to drain before launching its next work', async () => {
    const f = fixture();
    const controller = new AbortController();
    let releaseDrain;
    const drained = new Promise((resolve) => {
      releaseDrain = resolve;
    });
    let reportStarted;
    const started = new Promise((resolve) => {
      reportStarted = resolve;
    });
    let launches = 0;
    const options = {
      workingDirectory: f.workspace,
      spawnCliOverride: async function* (launch) {
        launches++;
        const agent = launch.args[launch.args.indexOf('--agent') + 1];
        const frames = fakeEvents(agent, launch.cwd, `drain-session-${launches}`, 'OK');
        if (launches === 1) {
          reportStarted();
          yield frames[0];
          await drained;
          yield frames[1];
        } else {
          yield* frames;
        }
      },
    };
    let first, second;
    try {
      first = collect(f.service.invoke('Canceled work.', { ...options, signal: controller.signal }));
      await started;
      controller.abort();
      let nextWorkEnded = false;
      second = collect(f.service.invoke('Next work.', options)).then((events) => {
        nextWorkEnded = true;
        return events;
      });
      await new Promise(setImmediate);
      assert.equal(launches, 1, 'a live canceled CLI must retain exclusive profile access');
      assert.equal(nextWorkEnded, false, 'next work must wait for cleanup rather than fail AGY_NATIVE_BUSY');
      releaseDrain();
      const [oldEvents, nextEvents] = await Promise.all([first, second]);
      assert.equal(oldEvents.at(-1).errorCode, 'AGY_CANCELLED');
      assert.equal(nextEvents.at(-1).errorCode, undefined);
      assert.equal(launches, 2);
    } finally {
      releaseDrain();
      await Promise.allSettled([first, second]);
      f.cleanup();
    }
  });

  test('queues ordinary work from another thread while the native profile is occupied', async () => {
    const f = fixture();
    let releaseDrain;
    const drained = new Promise((resolve) => {
      releaseDrain = resolve;
    });
    let reportStarted;
    const started = new Promise((resolve) => {
      reportStarted = resolve;
    });
    let first, second;
    try {
      first = collect(
        f.service.invoke('Active work.', {
          workingDirectory: f.workspace,
          spawnCliOverride: async function* (launch) {
            const agent = launch.args[launch.args.indexOf('--agent') + 1];
            reportStarted();
            await drained;
            yield* fakeEvents(agent, launch.cwd, 'active-session', 'OK');
          },
        }),
      );
      await started;
      let secondSpawned = false;
      second = collect(
        f.service.invoke('Concurrent work.', {
          workingDirectory: f.workspace,
          spawnCliOverride: async function* (launch) {
            secondSpawned = true;
            yield* fakeEvents(
              launch.args[launch.args.indexOf('--agent') + 1],
              launch.cwd,
              'second-thread-session',
              'OK',
            );
          },
        }),
      );
      await new Promise(setImmediate);
      assert.equal(secondSpawned, false);
      releaseDrain();
      const events = await second;
      assert.equal(events.at(-1).errorCode, undefined);
      assert.equal(secondSpawned, true);
    } finally {
      releaseDrain();
      await Promise.allSettled([first, second]);
      f.cleanup();
    }
  });

  test('never launches next work canceled while the prior profile is draining', async () => {
    const f = fixture();
    const previousAbort = new AbortController();
    const nextAbort = new AbortController();
    let releaseDrain;
    const drained = new Promise((resolve) => {
      releaseDrain = resolve;
    });
    let reportStarted;
    const started = new Promise((resolve) => {
      reportStarted = resolve;
    });
    let first, next;
    try {
      first = collect(
        f.service.invoke('Previous work.', {
          workingDirectory: f.workspace,
          signal: previousAbort.signal,
          spawnCliOverride: async function* (launch) {
            const agent = launch.args[launch.args.indexOf('--agent') + 1];
            reportStarted();
            await drained;
            yield* fakeEvents(agent, launch.cwd, 'canceled-profile-session', 'OK');
          },
        }),
      );
      await started;
      previousAbort.abort();
      let nextSpawned = false;
      next = collect(
        f.service.invoke('Canceled next work.', {
          workingDirectory: f.workspace,
          signal: nextAbort.signal,
          spawnCliOverride: async function* () {
            nextSpawned = true;
            yield* [];
          },
        }),
      );
      await new Promise(setImmediate);
      nextAbort.abort();
      releaseDrain();
      const events = await next;
      assert.equal(nextSpawned, false);
      assert.equal(events.at(-1).errorCode, 'AGY_CANCELLED');
    } finally {
      releaseDrain();
      await Promise.allSettled([first, next]);
      f.cleanup();
    }
  });

  test('compiles owner-bound L0 independently of caller prepend and resume fallback', async () => {
    const calls = [];
    const f = fixture(async (options) => {
      calls.push(options);
      return '# Identity\nHOST-COMPILED-NATIVE-L0\n';
    });
    try {
      let prepared;
      const events = await collect(
        f.service.invoke('Answer the task.', {
          workingDirectory: f.workspace,
          systemPrompt: 'DYNAMIC-PACK-PREPEND',
          resumeFallbackSystemPrompt: 'DYNAMIC-PACK-RESUME',
          callbackEnv: {
            CAT_CAFE_USER_ID: 'owner-native',
            CAT_CAFE_API_URL: 'http://127.0.0.1:3012',
            CAT_CAFE_INVOCATION_ID: 'l0-inv',
            CAT_CAFE_CALLBACK_TOKEN: 'fixture-l0-token',
          },
          beforeProviderLaunch: async (request) => {
            prepared = request;
          },
          spawnCliOverride: async function* (launch) {
            const agent = launch.args[launch.args.indexOf('--agent') + 1];
            yield* fakeEvents(agent, launch.cwd, 'compiled-l0-session', 'OK');
          },
        }),
      );
      assert.equal(events.at(-1).errorCode, undefined);
      assert.equal(f.service.injectsL0Natively(), true);
      assert.deepEqual(calls, [{ catId: 'gemini38', userId: 'owner-native', projection: 'owner' }]);
      assert.match(prepared.nativeInstructions[0].body, /HOST-COMPILED-NATIVE-L0/);
      assert.ok(!prepared.nativeInstructions[0].body.includes('DYNAMIC-PACK'));
    } finally {
      f.cleanup();
    }
  });

  test('fails closed before AGY starts when canonical L0 compilation fails', async () => {
    const f = fixture(async () => {
      throw new Error('canonical L0 unavailable');
    });
    try {
      let spawned = false;
      const events = await collect(
        f.service.invoke('Read.', {
          workingDirectory: f.workspace,
          systemPrompt: 'A caller prepend cannot substitute for native L0.',
          spawnCliOverride: async function* () {
            spawned = true;
          },
        }),
      );
      assert.equal(spawned, false);
      assert.deepEqual(
        events.map((event) => event.type),
        ['error', 'done'],
      );
      assert.equal(events.at(-1).errorCode, 'AGY_NATIVE_PREFLIGHT');
      assert.match(events[0].error, /canonical L0 unavailable/);
    } finally {
      f.cleanup();
    }
  });

  test('requires an explicit resolved workspace instead of inheriting the API process cwd', async () => {
    const f = fixture();
    try {
      let spawned = false;
      const events = await collect(
        f.service.invoke('Read.', {
          systemPrompt: '# Identity\nF325.\n',
          spawnCliOverride: async function* () {
            spawned = true;
            yield* [];
          },
        }),
      );
      assert.equal(spawned, false);
      assert.match(events[0].error, /explicit.*workingDirectory/i);
    } finally {
      f.cleanup();
    }
  });

  test('refuses a workspace outside the operator trusted list before AGY starts', async () => {
    const f = fixture();
    try {
      const other = join(f.base, 'other');
      mkdirSync(other);
      for (const trustedWorkspaces of [[], [other]]) {
        const service = new AgyNativeAgentService({
          catId: 'gemini38',
          profile: {
            enabled: true,
            profileId: 'gemini38',
            homeRoot: join(f.base, 'profiles'),
            model: 'gemini-3.8-flash-high',
            trustedWorkspaces,
          },
          command: '/usr/bin/true',
          l0CompilerFn: async () => '# Identity\nF325.\n',
        });
        let spawned = false;
        const events = await collect(
          service.invoke('Read.', {
            workingDirectory: f.workspace,
            systemPrompt: '# Identity\nF325.\n',
            spawnCliOverride: async function* () {
              spawned = true;
              yield* [];
            },
          }),
        );
        assert.equal(spawned, false);
        assert.match(events[0].error, /trusted workspace/i);
      }
    } finally {
      f.cleanup();
    }
  });

  test('refuses an OAuth profile overlapping the model-readable workspace', async () => {
    const f = fixture();
    try {
      const service = new AgyNativeAgentService({
        catId: 'gemini38',
        profile: {
          enabled: true,
          profileId: 'gemini38',
          homeRoot: join(f.workspace, 'profiles'),
          model: 'gemini-3.8-flash-high',
          trustedWorkspaces: [f.workspace],
        },
        command: '/usr/bin/true',
        l0CompilerFn: async () => '# Identity\nF325.\n',
      });
      let spawned = false;
      const events = await collect(
        service.invoke('Read.', {
          workingDirectory: f.workspace,
          systemPrompt: '# Identity\nF325.\n',
          spawnCliOverride: async function* () {
            spawned = true;
            yield* [];
          },
        }),
      );
      assert.equal(spawned, false);
      assert.equal(events[0].errorCode, 'AGY_NATIVE_PREFLIGHT');
      assert.match(events[0].error, /profile HOME overlaps/i);
    } finally {
      f.cleanup();
    }
  });

  test('declares queued native freshness and delivers a content-free notice before the next turn', async () => {
    const f = fixture();
    try {
      assert.deepEqual(f.service.freshnessCarrierCapability(), {
        provider: 'google',
        carrier: 'agy_stream_json',
        deliverySemantics: 'queued_internal_turn',
        activeInvocationGuidance: 'unsupported',
      });
      const notice = { text: '📬 One new message. Read the current thread with cat_cafe_get_thread_context.' };
      const actions = [];
      const events = await collect(
        f.service.invoke('Continue the task.', {
          workingDirectory: f.workspace,
          systemPrompt: '# Identity\nF325.\n',
          callbackEnv: {
            CAT_CAFE_API_URL: 'http://127.0.0.1:3012',
            CAT_CAFE_INVOCATION_ID: 'freshness-inv-1',
            CAT_CAFE_CALLBACK_TOKEN: 'freshness-token-1',
          },
          activeInvocationFreshness: {
            idle: {
              prepare: async () => {
                actions.push('prepare');
                return notice;
              },
              commitDelivered: async (value, result) => actions.push(['commit', value, result]),
              defer: () => actions.push('defer'),
              markMissed: async () => actions.push('missed'),
            },
          },
          spawnCliOverride: async function* (options) {
            assert.equal(actions[0], 'prepare');
            const text = JSON.parse(options.stdinInput).message.content[0].text;
            assert.match(text, /^Continue the task\./);
            assert.match(text, /📬 One new message/);
            assert.ok(!text.includes('SECRET-MESSAGE-BODY'));
            const agentName = options.args[options.args.indexOf('--agent') + 1];
            yield* fakeEvents(agentName, options.cwd, 'agy-freshness-1', 'I will read it.');
          },
        }),
      );
      assert.equal(events.at(-1).errorCode, undefined);
      assert.deepEqual(actions, ['prepare', ['commit', notice, { acceptedTurnId: 'agy-freshness-1' }]]);
    } finally {
      f.cleanup();
    }
  });

  test('defers a prepared freshness notice if AGY never accepts the turn', async () => {
    const f = fixture();
    try {
      const actions = [];
      const events = await collect(
        f.service.invoke('Continue.', {
          workingDirectory: f.workspace,
          systemPrompt: '# Identity\nF325.\n',
          callbackEnv: {
            CAT_CAFE_API_URL: 'http://127.0.0.1:3012',
            CAT_CAFE_INVOCATION_ID: 'freshness-inv-2',
            CAT_CAFE_CALLBACK_TOKEN: 'freshness-token-2',
          },
          activeInvocationFreshness: {
            idle: {
              prepare: async () => ({ text: '📬 One new message.' }),
              commitDelivered: async () => actions.push('commit'),
              defer: () => actions.push('defer'),
              markMissed: async () => actions.push('missed'),
            },
          },
          spawnCliOverride: async function* () {
            yield* [];
          },
        }),
      );
      assert.equal(events.at(-1).errorCode, 'AGY_NATIVE_PREFLIGHT');
      assert.deepEqual(actions, ['defer']);
    } finally {
      f.cleanup();
    }
  });

  test('defers a prepared freshness notice when the accepted turn is denied or fails upstream', async () => {
    for (const outcome of ['denied', 'upstream-error']) {
      const f = fixture();
      try {
        const actions = [];
        const notice = { text: '📬 Read the current thread.' };
        const events = await collect(
          f.service.invoke('Continue.', {
            workingDirectory: f.workspace,
            systemPrompt: '# Identity\nF325.\n',
            callbackEnv: {
              CAT_CAFE_API_URL: 'http://127.0.0.1:3012',
              CAT_CAFE_INVOCATION_ID: 'freshness-inv-failure',
              CAT_CAFE_CALLBACK_TOKEN: 'freshness-token-failure',
            },
            activeInvocationFreshness: {
              idle: {
                prepare: async () => {
                  actions.push('prepare');
                  return notice;
                },
                commitDelivered: async () => actions.push('commit'),
                defer: () => actions.push('defer'),
                markMissed: async () => actions.push('missed'),
              },
            },
            spawnCliOverride: async function* (options) {
              const agentName = options.args[options.args.indexOf('--agent') + 1];
              const records = fakeEvents(
                agentName,
                options.cwd,
                'agy-freshness-failed',
                '',
                outcome === 'denied' ? [{ action: 'view_file', display_name: 'view_file' }] : [],
              );
              if (outcome === 'upstream-error') records[1].result.status = 'ERROR';
              yield* records;
            },
          }),
        );
        assert.equal(events.at(-1).errorCode, outcome === 'denied' ? 'AGY_PERMISSION_DENIED' : 'AGY_NATIVE_FAILED');
        assert.deepEqual(actions, ['prepare', 'defer'], outcome);
      } finally {
        f.cleanup();
      }
    }
  });

  test('launches one native L0 session with isolated HOME, canonical tools, and typed final', async () => {
    const f = fixture();
    try {
      let launch;
      let prepared;
      const events = await collect(
        f.service.invoke('Say hello.', {
          workingDirectory: f.workspace,
          systemPrompt: '# Identity\nYou are F325-TEST-CAT.\n',
          callbackEnv: {
            CAT_CAFE_API_URL: 'http://127.0.0.1:3012',
            CAT_CAFE_INVOCATION_ID: 'invocation-1',
            CAT_CAFE_CALLBACK_TOKEN: 'test-callback-token',
            CAT_CAFE_AGENT_KEY_FILES: 'must-not-inherit',
            F325_CALLBACK_EXTRA: 'fake-extra-secret',
          },
          beforeProviderLaunch: async (request) => {
            prepared = request;
            return { requestGenerationId: 'rg-1', generationOrdinal: 1, sessionId: 's-1' };
          },
          spawnCliOverride: async function* (options) {
            launch = options;
            const agentName = options.args[options.args.indexOf('--agent') + 1];
            yield* fakeEvents(agentName, options.cwd, 'agy-session-1', 'Hello from native AGY.\n');
          },
        }),
      );
      assert.equal(prepared.message.body, 'Say hello.');
      assert.equal(prepared.nativeInstructions.length, 1);
      assert.match(prepared.nativeInstructions[0].body, /F325-TEST-CAT/);
      assert.equal(prepared.runtime.protocol, 'stream-json');
      assert.equal(launch.env.HOME, realpathSync(join(f.base, 'profiles', 'gemini38')));
      assert.equal(launch.env.GEMINI_API_KEY, null);
      assert.equal(launch.env.CAT_CAFE_AGENT_KEY_SECRET, null);
      assert.equal(launch.env.CAT_CAFE_AGENT_KEY_FILES, null);
      assert.equal(launch.env.CAT_CAFE_CREDENTIAL_FILE, null);
      assert.equal(launch.env.CAT_CAFE_CALLBACK_TOKEN, null);
      assert.equal(launch.env.CAT_CAFE_INVOCATION_ID, null);
      assert.equal(launch.env.F325_CALLBACK_EXTRA, undefined);
      assert.equal(launch.inheritParentEnv, false);
      assert.ok(launch.args.includes('--sandbox'));
      assert.ok(launch.args.includes('--input-format'));
      assert.ok(!launch.args.includes('-p'));
      assert.equal(JSON.parse(launch.stdinInput).message.content[0].text, 'Say hello.');
      assert.ok(!launch.args.includes('--dangerously-skip-permissions'));
      assert.ok(!launch.args.includes('run_command'));
      const settings = JSON.parse(
        readFileSync(join(launch.env.HOME, '.gemini', 'antigravity-cli', 'settings.json'), 'utf8'),
      );
      assert.deepEqual(settings.permissions.allow, ['mcp(*)']);
      assert.deepEqual(
        events.map((event) => event.type),
        ['session_init', 'text', 'done'],
      );
      assert.equal(events[0].sessionId, 'agy-session-1');
      assert.equal(events[1].content, 'Hello from native AGY.\n');
      assert.equal(events[2].errorCode, undefined);
    } finally {
      f.cleanup();
    }
  });

  test('maps upstream SUCCESS with denied_actions to a terminal typed denial', async () => {
    const f = fixture();
    try {
      const events = await collect(
        f.service.invoke('Edit.', {
          workingDirectory: f.workspace,
          systemPrompt: '# Identity\nF325.\n',
          spawnCliOverride: async function* (options) {
            const agentName = options.args[options.args.indexOf('--agent') + 1];
            yield* fakeEvents(agentName, options.cwd, 'agy-denied-1', '', [
              { action: 'write_file', display_name: 'write task.ts' },
            ]);
          },
        }),
      );
      assert.deepEqual(
        events.map((event) => event.type),
        ['session_init', 'error', 'done'],
      );
      assert.equal(events[1].errorCode, 'AGY_PERMISSION_DENIED');
      assert.equal(events[2].errorCode, 'AGY_PERMISSION_DENIED');
    } finally {
      f.cleanup();
    }
  });

  test('reports cancellation before AGY init as a typed cancelled terminal', async () => {
    const f = fixture();
    const controller = new AbortController();
    try {
      const events = await collect(
        f.service.invoke('Read.', {
          workingDirectory: f.workspace,
          systemPrompt: '# Identity\nF325.\n',
          signal: controller.signal,
          spawnCliOverride: async function* () {
            controller.abort();
            yield* [];
          },
        }),
      );
      assert.deepEqual(
        events.map((event) => event.type),
        ['error', 'done'],
      );
      assert.equal(events.at(-1).errorCode, 'AGY_CANCELLED');
    } finally {
      f.cleanup();
    }
  });

  test('keeps an observed successful result when stop arrives after the terminal event', async () => {
    const f = fixture();
    const controller = new AbortController();
    try {
      const events = await collect(
        f.service.invoke('Read.', {
          workingDirectory: f.workspace,
          systemPrompt: '# Identity\nF325.\n',
          signal: controller.signal,
          spawnCliOverride: async function* (options) {
            const agentName = options.args[options.args.indexOf('--agent') + 1];
            yield* fakeEvents(agentName, options.cwd, 'agy-done-before-stop', 'Completed.');
            controller.abort();
          },
        }),
      );
      assert.deepEqual(
        events.map((event) => event.type),
        ['session_init', 'text', 'done'],
      );
      assert.equal(events.at(-1).errorCode, undefined);
    } finally {
      f.cleanup();
    }
  });

  test('binds canonical MCP to a per-turn credential file that disappears after the turn', async () => {
    const f = fixture();
    try {
      let credentialPath;
      let config;
      const events = await collect(
        f.service.invoke('Read the current thread.', {
          workingDirectory: f.workspace,
          systemPrompt: '# Identity\nF325.\n',
          requiredTools: ['cat-cafe-collab::cat_cafe_get_thread_context'],
          auditContext: {
            invocationId: 'inv-1',
            executionId: 'parent-execution',
            threadId: 'thread-1',
            catId: 'gemini38',
            userId: 'owner',
          },
          callbackEnv: {
            CAT_CAFE_API_URL: 'http://127.0.0.1:3012',
            CAT_CAFE_INVOCATION_ID: 'inv-1',
            CAT_CAFE_CALLBACK_TOKEN: 'secret-1',
          },
          spawnCliOverride: async function* (options) {
            assert.equal(options.env.CAT_CAFE_CALLBACK_TOKEN, null);
            assert.equal(options.bindExecutionOwner, true);
            assert.equal(options.env.CAT_CAFE_INVOCATION_ID, 'inv-1');
            assert.equal(options.env.CAT_CAFE_EXECUTION_ID, 'parent-execution');
            assert.equal(options.env.CAT_CAFE_THREAD_ID, 'thread-1');
            assert.equal(options.env.CAT_CAFE_USER_ID, 'owner');
            assert.equal(options.env.CAT_CAFE_CAT_ID, 'gemini38');
            config = JSON.parse(readFileSync(join(options.env.HOME, '.gemini', 'config', 'mcp_config.json'), 'utf8'));
            credentialPath = config.mcpServers['cat-cafe-collab'].env.CAT_CAFE_CREDENTIAL_FILE;
            assert.deepEqual(JSON.parse(readFileSync(credentialPath, 'utf8')), {
              invocationId: 'inv-1',
              callbackToken: 'secret-1',
            });
            const agentName = options.args[options.args.indexOf('--agent') + 1];
            yield* fakeEvents(agentName, options.cwd, 'agy-mcp-1', 'Read complete.');
          },
        }),
      );
      assert.equal(events.at(-1).errorCode, undefined, JSON.stringify(events));
      assert.ok(Object.hasOwn(config.mcpServers, 'cat-cafe-collab'));
      assert.ok(Object.hasOwn(config.mcpServers, 'cat-cafe-memory'));
      assert.ok(Object.hasOwn(config.mcpServers, 'cat-cafe-limb'));
      assert.ok(!JSON.stringify(config).includes('secret-1'));
      assert.throws(() => readFileSync(credentialPath, 'utf8'), /ENOENT/);
    } finally {
      f.cleanup();
    }
  });

  test('refuses executable workspace hooks before spawning AGY', async () => {
    const f = fixture();
    try {
      mkdirSync(join(f.workspace, '.agents'));
      writeFileSync(join(f.workspace, '.agents', 'hooks.json'), '{}');
      let spawned = false;
      const events = await collect(
        f.service.invoke('Read.', {
          workingDirectory: f.workspace,
          systemPrompt: '# Identity\nF325.\n',
          spawnCliOverride: async function* () {
            spawned = true;
            yield* [];
          },
        }),
      );
      assert.equal(spawned, false);
      assert.deepEqual(
        events.map((event) => event.type),
        ['error', 'done'],
      );
      assert.equal(events[0].errorCode, 'AGY_WORKSPACE_CUSTOMIZATION');
    } finally {
      f.cleanup();
    }
  });

  test('refuses an unvalidated MCP server in the isolated profile before spawn', async () => {
    const f = fixture();
    try {
      const configDir = join(f.base, 'profiles', 'gemini38', '.gemini', 'config');
      mkdirSync(configDir, { recursive: true });
      writeFileSync(
        join(configDir, 'mcp_config.json'),
        JSON.stringify({ mcpServers: { rogue: { command: '/bin/echo' } } }),
      );
      let spawned = false;
      const events = await collect(
        f.service.invoke('Read.', {
          workingDirectory: f.workspace,
          systemPrompt: '# Identity\nF325.\n',
          spawnCliOverride: async function* () {
            spawned = true;
            yield* [];
          },
        }),
      );
      assert.equal(spawned, false);
      assert.deepEqual(
        events.map((event) => event.type),
        ['error', 'done'],
      );
      assert.match(events[0].error, /MCP server is not host-owned/i);
    } finally {
      f.cleanup();
    }
  });
});

test('Native archives provider frames with invocation provenance and retains unknown event evidence', async () => {
  const archived = [];
  const f = fixture(
    undefined,
    {},
    {
      rawArchive: {
        append: async (id, payload) => archived.push({ id, payload }),
        getPath: (id) => `data/cli-raw-archive/${id}.ndjson`,
      },
    },
  );
  try {
    const events = await collect(
      f.service.invoke('Read the project.', {
        workingDirectory: f.workspace,
        invocationId: 'native-raw-test',
        spawnCliOverride: async function* (launch) {
          const frames = fakeEvents(
            launch.args[launch.args.indexOf('--agent') + 1],
            launch.cwd,
            'raw-session',
            'Done.',
          );
          yield frames[0];
          yield { event: 'future_observation', callbackToken: 'must-not-archive', detail: 'retain as unknown' };
          yield frames[1];
        },
      }),
    );
    assert.equal(archived.length, 3);
    assert.ok(archived.every((item) => item.id === 'native-raw-test'));
    assert.equal(archived[1].payload.callbackToken, '[redacted]');
    assert.deepEqual(events.at(-1).metadata.diagnostics.agyNative.unknownEvents, ['future_observation']);
    assert.equal(
      events.at(-1).metadata.diagnostics.agyNative.rawArchivePath,
      'data/cli-raw-archive/native-raw-test.ndjson',
    );
  } finally {
    f.cleanup();
  }
});
