import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { invokeCollectivePrivate } from '../src/domains/cats/services/agents/invocation/collective-private-invocation.js';
import { invokeCollectivePublic } from '../src/domains/cats/services/agents/invocation/collective-public-invocation.js';
import { CodexAgentService } from '../src/domains/cats/services/agents/providers/CodexAgentService.js';
import type { AgentMessage, AgentService } from '../src/domains/cats/services/types.js';
import { F320AccountWire } from './helpers/f320-account-wire.js';
import { ownedManagedFixture } from './helpers/f320-owned-account.js';
import { fakeL0Compiler } from './helpers/fake-l0-compiler.js';

for (const lane of ['public', 'private'] as const)
  for (const carrier of ['exec_json', 'app_server'] as const)
    test(`actual managed Collective ${lane} configured ${carrier} retains B owner with an isolated execution cwd`, async () => {
      const f = ownedManagedFixture();
      try {
        let launches = 0;
        const wires: F320AccountWire[] = [];
        const native = new CodexAgentService({
          carrierMode: carrier,
          cliCommand: 'codex',
          l0CompilerFn: fakeL0Compiler,
          rawArchive: { append: async () => {} },
        });
        const service: AgentService = {
          supportsToolExecutionPolicy: (policy) => native.supportsToolExecutionPolicy(policy),
          async *invoke(prompt, options) {
            assert.equal(options?.codexAccountLaunch?.credentialHome, f.layout.credentialHome);
            assert.equal(options?.accountEnv, undefined);
            yield* native.invoke(prompt, {
              ...options,
              agentCarrierSessionFactory: async (launch) => {
                launches++;
                const home = launch.env?.CODEX_HOME;
                assert.ok(home);
                assert.notEqual(home, f.layout.credentialHome);
                assert.notEqual(launch.cwd, f.owner);
                assert.equal(launch.env?.CODEX_SQLITE_HOME, home);
                assert.equal(realpathSync(join(home, 'auth.json')), join(f.layout.credentialHome, 'auth.json'));
                const wire = new F320AccountWire({
                  sqlite_home: home,
                  cli_auth_credentials_store: 'file',
                  forced_chatgpt_workspace_id: f.identity.workspaceId,
                });
                wires.push(wire);
                return wire;
              },
              spawnCliOverride: async function* (launch) {
                launches++;
                const home = launch.env?.CODEX_HOME;
                assert.ok(home);
                assert.notEqual(home, f.layout.credentialHome);
                assert.equal(launch.env?.CODEX_SQLITE_HOME, home);
                assert.equal(realpathSync(join(home, 'auth.json')), join(f.layout.credentialHome, 'auth.json'));
                yield { type: 'thread.started', thread_id: 'fixture-thread' };
                yield { type: 'item.completed', item: { type: 'agent_message', text: 'fixture reply' } };
                yield { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } };
              },
            });
          },
        };
        const callbackEnv = {
          CAT_CAFE_CAT_ID: 'codex-sol',
          CAT_CAFE_USER_ID: 'fixture',
          CAT_CAFE_THREAD_ID: 'fixture-thread',
          CAT_CAFE_INVOCATION_ID: 'fixture-invocation',
          CAT_CAFE_EXECUTION_ID: 'fixture-execution',
          CAT_CAFE_CALLBACK_TOKEN: 'fixture',
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
            sequence: 1,
            actor: { kind: 'human', humanId: 'human_fixture', displayName: 'Fixture' },
            acceptedAt: new Date().toISOString(),
          },
        };
        let run: AsyncIterable<AgentMessage>;
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
          const workspaceRoot = join(f.root, 'private-work');
          mkdirSync(workspaceRoot);
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
        const events = [];
        for await (const event of run) events.push(event);
        assert.deepEqual(
          events.filter((event) => event.type === 'error'),
          [],
        );
        assert.equal(launches, 1);
        // Existing scoped policy deliberately selects exec_json for both configured carriers.
        assert.equal(wires.length, 0);
        assert.ok(events.some((event) => event.type === 'done'));
      } finally {
        f.close();
      }
    });
