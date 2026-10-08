import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { catRegistry, createCatId } from '@cat-cafe/shared';
import { finalizeCodexAccountEnvironment } from '../src/config/codex-account-environment.js';
import { invokeCollectivePrivate } from '../src/domains/cats/services/agents/invocation/collective-private-invocation.js';
import { invokeCollectivePublic } from '../src/domains/cats/services/agents/invocation/collective-public-invocation.js';
import { prepareCollectiveCodexHome } from '../src/domains/cats/services/agents/providers/collective-codex-home.js';
import type { AgentService } from '../src/domains/cats/services/types.js';

for (const lane of ['public', 'private'] as const)
  test(`real Collective ${lane} producer carries selected B rather than ambient A`, async (t) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'f320-collective-entry-')));
    const a = join(root, 'a'),
      b = join(root, 'b');
    for (const home of [a, b]) {
      await mkdir(home);
      await writeFile(join(home, 'auth.json'), `fixture-${home === a ? 'A' : 'B'}`);
    }
    await mkdir(join(root, '.cat-cafe'));
    await writeFile(
      join(root, '.cat-cafe/accounts.json'),
      JSON.stringify({ codex: { authType: 'oauth', envVars: { CODEX_HOME: b } } }),
    );
    const saved = {
      CODEX_HOME: process.env.CODEX_HOME,
      CAT_CAFE_GLOBAL_CONFIG_ROOT: process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT,
    };
    process.env.CODEX_HOME = a;
    process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = root;
    const cat = catRegistry.getOrThrow('codex-sol').config;
    const previousBinding = cat.accountRef;
    cat.accountRef = 'codex';
    t.after(async () => {
      if (previousBinding === undefined) delete cat.accountRef;
      else cat.accountRef = previousBinding;
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(root, { recursive: true, force: true });
    });
    let consumed = false;
    const service: AgentService = {
      supportsToolExecutionPolicy: () => true,
      async *invoke(_prompt, options) {
        consumed = true;
        assert.equal(options?.codexAccountLaunch?.credentialHome, b);
        assert.equal(options?.accountEnv, undefined, 'public Work must not copy arbitrary private account env');
        assert.equal(options.codexAccountLaunch.accountRef, 'codex');
        const publicEnv = await prepareCollectiveCodexHome(
          options.workingDirectory!,
          'oauth',
          options.codexAccountLaunch.credentialHome,
        );
        assert.equal(await realpath(join(publicEnv.CODEX_HOME, 'auth.json')), join(b, 'auth.json'));
        const final = finalizeCodexAccountEnvironment(options.codexAccountLaunch, {
          cwd: options.workingDirectory!,
          args: ['exec'],
          env: { ...publicEnv, CODEX_SQLITE_HOME: a },
          executionHome: publicEnv.CODEX_HOME,
        });
        assert.equal(final.CODEX_SQLITE_HOME, await realpath(publicEnv.CODEX_HOME));
        yield { type: 'done', catId: createCatId('codex-sol'), timestamp: Date.now() };
      },
    };
    const callbackEnv = {
      CAT_CAFE_CAT_ID: 'codex-sol',
      CAT_CAFE_USER_ID: 'fixture-user',
      CAT_CAFE_THREAD_ID: 'fixture-thread',
      CAT_CAFE_INVOCATION_ID: 'fixture-invocation',
      CAT_CAFE_EXECUTION_ID: 'fixture-execution',
      CAT_CAFE_CALLBACK_TOKEN: 'fixture-callback',
    };
    const source = {
      serviceInstanceId: 'svc_fixture',
      collectiveId: 'col_fixture',
      connectionId: 'con_fixture',
      eventId: 'evt_fixture',
      location: { channelId: 'fixture' },
      catId: 'codex-sol',
      participationRevision: 1,
    };
    const context = {
      events: [],
      source: {
        ...source,
        body: 'fixture request',
        actor: { kind: 'human', humanId: 'human_fixture', displayName: 'Fixture' },
        sequence: 1,
        acceptedAt: new Date().toISOString(),
      },
    };
    let run: AsyncIterable<unknown>;
    if (lane === 'public')
      run = invokeCollectivePublic({
        source: {
          source,
          sourceRef: 'message:fixture',
          displayName: 'Fixture',
          context,
          grant: { kind: 'collective-participation', originTriggerMessageId: 'fixture', source },
        } as Parameters<typeof invokeCollectivePublic>[0]['source'],
        service,
        callbackEnv,
        signal: new AbortController().signal,
      });
    else {
      const workspaceRoot = join(root, 'work');
      await mkdir(workspaceRoot);
      run = invokeCollectivePrivate({
        work: {
          sourceRef: 'message:fixture',
          context,
          grant: { source },
          work: { task: { id: 'fixture', title: 'Fixture', why: 'Fixture' } },
        } as Parameters<typeof invokeCollectivePrivate>[0]['work'],
        policy: {
          mode: 'collective_work',
          taskId: 'fixture',
          threadId: 'fixture-thread',
          executionRevision: 1,
          executionRef: 'message:fixture',
          workspaceRoot,
          readOnlyRoots: [fileURLToPath(new URL('../../../cat-cafe-skills', import.meta.url))],
        },
        originMessage: { content: 'fixture continuation' } as Parameters<
          typeof invokeCollectivePrivate
        >[0]['originMessage'],
        service,
        callbackEnv,
        signal: new AbortController().signal,
        revalidate: async () => {},
      });
    }
    for await (const _event of run) {
      /* real producer exercised */
    }
    assert.equal(consumed, true);
  });
