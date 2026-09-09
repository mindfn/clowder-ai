import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ClaudeSdkAgentService } from '../dist/domains/cats/services/agents/providers/ClaudeSdkAgentService.js';
import { OpenCodeServerAgentService } from '../dist/domains/cats/services/agents/providers/OpenCodeServerAgentService.js';
import { closeStaleOpenCodeServerHosts } from '../dist/domains/cats/services/agents/providers/OpenCodeServerHost.js';

class AsyncInbox {
  #values = [];
  #waiters = [];
  #closed = false;

  push(value) {
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.#values.push(value);
  }

  close() {
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator]() {
    return {
      next: () => {
        const value = this.#values.shift();
        if (value !== undefined) return Promise.resolve({ value, done: false });
        if (this.#closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}

function activeRunRegistration() {
  return {
    invocationId: 'inv-live-carrier',
    dispatcher: undefined,
    released: false,
    register(dispatcher) {
      this.dispatcher = dispatcher;
      return () => {
        this.released = true;
      };
    },
  };
}

describe('live member carriers', () => {
  it('Claude SDK streams append into the active query and interrupts only for explicit steer', async () => {
    let sdkOptions;
    let sdkInput;
    let interruptCount = 0;
    const events = new AsyncInbox();
    const registration = activeRunRegistration();
    const service = new ClaudeSdkAgentService({
      catId: 'opus',
      model: 'claude-test',
      l0CompilerFn: async () => 'compiled L0',
      queryFn: ({ prompt, options }) => {
        sdkOptions = options;
        sdkInput = prompt[Symbol.asyncIterator]();
        return {
          interrupt: async () => {
            interruptCount += 1;
          },
          [Symbol.asyncIterator]: () => events[Symbol.asyncIterator](),
        };
      },
    });

    const output = service
      .invoke('initial body', {
        invocationId: registration.invocationId,
        activeRunDispatch: registration,
        systemPrompt: 'route identity',
        toolExecutionPolicy: { mode: 'read_only', replayDeniedToolNames: [] },
      })
      [Symbol.asyncIterator]();
    const firstPending = output.next();
    while (!sdkInput) await new Promise((resolve) => setImmediate(resolve));
    const initialInput = await sdkInput.next();
    assert.equal(initialInput.value.message.content[0].text, 'initial body');
    events.push({ type: 'system', subtype: 'init', session_id: 'sdk-session-1' });
    const first = await firstPending;
    assert.equal(first.value.type, 'session_init');
    assert.equal(registration.dispatcher.capabilities.append, true);
    assert.equal(registration.dispatcher.capabilities.steer, true);
    assert.match(sdkOptions.systemPrompt, /compiled L0/);
    assert.match(sdkOptions.systemPrompt, /route identity/);
    assert.equal(sdkOptions.permissionMode, 'plan');
    assert.equal(sdkOptions.extraArgs, undefined, 'the SDK carrier must not synthesize unsupported Claude CLI flags');
    assert.equal(sdkOptions.env.CLAUDE_CODE_EFFORT_LEVEL, 'high');

    const appended = await registration.dispatcher.dispatch(
      { text: 'append body' },
      { expectedInvocationId: registration.invocationId, force: false },
    );
    assert.equal(appended.accepted, true);
    assert.equal((await sdkInput.next()).value.message.content[0].text, 'append body');
    assert.equal(interruptCount, 0);

    const steered = await registration.dispatcher.dispatch(
      { text: 'steer body' },
      { expectedInvocationId: registration.invocationId, force: true },
    );
    assert.equal(steered.accepted, true);
    assert.equal(interruptCount, 1);
    assert.equal((await sdkInput.next()).value.message.content[0].text, 'steer body');

    events.push({
      type: 'stream_event',
      session_id: 'sdk-session-1',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'done' } },
    });
    assert.equal((await output.next()).value.content, 'done');
    events.close();
    assert.equal((await output.next()).value.type, 'done');
    assert.equal(registration.released, true);
  });

  it('Claude SDK surfaces sanitized stderr instead of replacing it with a generic process-exit message', async () => {
    const service = new ClaudeSdkAgentService({
      catId: 'opus',
      model: 'claude-test',
      l0CompilerFn: async () => 'compiled L0',
      queryFn: ({ options }) => ({
        interrupt: async () => {},
        async *[Symbol.asyncIterator]() {
          options.stderr?.("error: unknown option '--effort'\n");
          throw new Error('Claude Code process exited with code 1');
        },
      }),
    });

    const messages = [];
    for await (const message of service.invoke('initial body')) messages.push(message);

    const failure = messages.find((message) => message.type === 'error');
    assert.equal(failure.error, "error: unknown option '--effort'");
  });

  it('Claude SDK rejects a steer whose provider interrupt never acknowledges', async () => {
    const events = new AsyncInbox();
    const registration = activeRunRegistration();
    const service = new ClaudeSdkAgentService({
      catId: 'opus',
      model: 'claude-test',
      activeRunControlTimeoutMs: 5,
      l0CompilerFn: async () => 'compiled L0',
      queryFn: () => ({
        interrupt: async () => await new Promise(() => {}),
        [Symbol.asyncIterator]: () => events[Symbol.asyncIterator](),
      }),
    });

    const output = service
      .invoke('initial body', {
        invocationId: registration.invocationId,
        activeRunDispatch: registration,
        toolExecutionPolicy: { mode: 'read_only', replayDeniedToolNames: [] },
      })
      [Symbol.asyncIterator]();
    const firstPending = output.next();
    events.push({ type: 'system', subtype: 'init', session_id: 'sdk-session-timeout' });
    assert.equal((await firstPending).value.type, 'session_init');

    const rejected = await registration.dispatcher.dispatch(
      { text: 'must not be appended after an unacknowledged interrupt' },
      { expectedInvocationId: registration.invocationId, force: true },
    );
    assert.deepEqual(rejected, { accepted: false, reason: 'provider_rejected' });

    events.close();
    assert.equal((await output.next()).value.type, 'done');
  });

  it('OpenCode server keeps one session live for append and aborts only for explicit steer', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cat-cafe-opencode-server-'));
    const configPath = join(root, 'opencode.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        instructions: [],
        mcp: { memory: { type: 'remote', url: '{env:CAT_CAFE_MCP_URL}' } },
      }),
    );
    const events = new AsyncInbox();
    const requests = [];
    const host = {
      async ensureStarted() {},
      async request(path, options = {}) {
        requests.push({ path, options });
        if (path === '/session' && options.method === 'POST') return { id: 'oc-session-1' };
        return undefined;
      },
      async openEvents() {
        return events;
      },
      async close() {},
    };
    const registration = activeRunRegistration();
    const service = new OpenCodeServerAgentService({ catId: 'opencode', model: 'anthropic/claude-test', host });
    const output = service
      .invoke('initial body', {
        invocationId: registration.invocationId,
        activeRunDispatch: registration,
        workingDirectory: root,
        callbackEnv: { OPENCODE_CONFIG: configPath, CAT_CAFE_MCP_URL: 'https://mcp.example.test' },
      })
      [Symbol.asyncIterator]();

    assert.equal((await output.next()).value.type, 'session_init');
    const eventPending = output.next();
    await new Promise((resolve) => setImmediate(resolve));
    const configPatch = requests.find((request) => request.path === '/config');
    assert.equal(configPatch.options.body.mcp.memory.url, 'https://mcp.example.test');
    const initial = requests.find((request) => request.path.endsWith('/prompt_async'));
    assert.equal(initial.options.body.parts[0].text, 'initial body');
    assert.deepEqual(initial.options.body.model, { providerID: 'anthropic', modelID: 'claude-test' });

    const appended = await registration.dispatcher.dispatch(
      { text: 'append body' },
      { expectedInvocationId: registration.invocationId, force: false },
    );
    assert.equal(appended.accepted, true);
    assert.equal(requests.filter((request) => request.path.endsWith('/abort')).length, 0);

    const steered = await registration.dispatcher.dispatch(
      { text: 'steer body' },
      { expectedInvocationId: registration.invocationId, force: true },
    );
    assert.equal(steered.accepted, true);
    assert.equal(requests.filter((request) => request.path.endsWith('/abort')).length, 1);
    const prompts = requests.filter((request) => request.path.endsWith('/prompt_async'));
    assert.deepEqual(
      prompts.map((request) => request.options.body.parts[0].text),
      ['initial body', 'append body', 'steer body'],
    );
    const latestMessageId = prompts.at(-1).options.body.messageID;
    events.push({
      type: 'message.updated',
      properties: { info: { id: latestMessageId, sessionID: 'oc-session-1', role: 'user' } },
    });
    events.push({
      type: 'message.part.delta',
      properties: {
        sessionID: 'oc-session-1',
        messageID: latestMessageId,
        partID: 'part-user',
        field: 'text',
        delta: 'Dispatch Mission Context must not enter the response bubble',
      },
    });
    events.push({
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'part-user-complete',
          sessionID: 'oc-session-1',
          messageID: latestMessageId,
          type: 'text',
          text: 'the complete user prompt must not enter the response bubble either',
        },
      },
    });
    events.push({
      type: 'message.updated',
      properties: { info: { id: 'assistant-1', sessionID: 'oc-session-1', role: 'assistant' } },
    });
    events.push({
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'part-assistant',
          sessionID: 'oc-session-1',
          messageID: 'assistant-1',
          type: 'text',
          text: 'done',
        },
      },
    });
    events.push({ type: 'session.idle', properties: { sessionID: 'oc-session-1' } });
    assert.equal((await eventPending).value.content, 'done');
    assert.equal((await output.next()).value.type, 'done');
    assert.equal(registration.released, true);
  });

  it('OpenCode server host registry closes only retired profiles and can drain all hosts on shutdown', async () => {
    const closed = [];
    const registry = new Map([
      ['active', { close: async () => closed.push('active') }],
      ['retired', { close: async () => closed.push('retired') }],
    ]);

    await closeStaleOpenCodeServerHosts(registry, new Set(['active']));
    assert.deepEqual(closed, ['retired']);
    assert.deepEqual([...registry.keys()], ['active']);

    await closeStaleOpenCodeServerHosts(registry, new Set());
    assert.deepEqual(closed, ['retired', 'active']);
    assert.equal(registry.size, 0);
  });
});
