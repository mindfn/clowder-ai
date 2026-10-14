import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { projectAgyNativeTurn, readAgyNativeTurn } = await import(
  '../dist/domains/cats/services/agents/providers/agy-native/agy-native-turn.js'
);
const { summarizeAgyStreamJsonTurn } = await import(
  '../dist/domains/cats/services/agents/providers/agy-stream-json-parser.js'
);

const expected = { agentName: 'f325-agent', spawnCwd: '/tmp/f325-sandbox', model: 'gemini-3.8-flash-high' };
const init = {
  event: 'init',
  conversation_id: 'session-1',
  init: {
    agent: expected.agentName,
    cwd: expected.spawnCwd,
    model: expected.model,
    permission_mode: 'request-review',
  },
};

describe('F325 native stream boundary', () => {
  test('bounds accumulated upstream output before a tool can exhaust the API process', async () => {
    async function* oversized() {
      yield init;
      yield {
        event: 'step_update',
        step_update: {
          conversation_id: 'session-1',
          step_index: 1,
          state: 'DONE',
          step_type: 'tool',
          tool_name: 'view_file',
          tool_info: { output: 'x'.repeat(9 * 1024 * 1024) },
        },
      };
      yield { event: 'result', result: { conversation_id: 'session-1', status: 'SUCCESS', response: 'done' } };
    }
    await assert.rejects(() => readAgyNativeTurn(oversized(), expected), /stream.*limit|bounded.*output/i);
  });

  test('rejects a second terminal result in a one-turn process', async () => {
    async function* duplicate() {
      yield init;
      yield { event: 'result', result: { conversation_id: 'session-1', status: 'SUCCESS', response: 'one' } };
      yield { event: 'result', result: { conversation_id: 'session-1', status: 'SUCCESS', response: 'two' } };
    }
    await assert.rejects(() => readAgyNativeTurn(duplicate(), expected), /multiple terminal/i);
  });

  test('does not report success if an undeclared native command appears in the tool steps', () => {
    const lines = [
      JSON.stringify(init),
      JSON.stringify({
        event: 'step_update',
        step_update: {
          conversation_id: 'session-1',
          step_index: 1,
          state: 'DONE',
          step_type: 'tool',
          tool_name: 'run_command',
          tool_info: { parameters: { CommandLine: 'echo unsafe' }, output: 'unsafe' },
        },
      }),
      JSON.stringify({
        event: 'result',
        result: { conversation_id: 'session-1', status: 'SUCCESS', response: 'done' },
      }),
    ];
    const turn = summarizeAgyStreamJsonTurn(lines);
    const messages = projectAgyNativeTurn(
      'gemini38',
      { provider: 'google', model: expected.model },
      { sessionId: 'session-1', turn, transportError: null },
      false,
    );
    assert.equal(messages.at(-1).errorCode, 'AGY_UNEXPECTED_TOOL');
    assert.ok(!messages.some((message) => message.type === 'text'));
  });

  test('only the exact task-scoped MCP pair may appear in a successful turn', () => {
    const lines = [
      JSON.stringify(init),
      JSON.stringify({
        event: 'step_update',
        step_update: {
          conversation_id: 'session-1',
          step_index: 1,
          state: 'DONE',
          step_type: 'tool',
          tool_name: 'call_mcp_tool',
          tool_info: {
            parameters: {
              ServerName: 'cat-cafe-collab',
              ToolName: 'cat_cafe_get_thread_context',
              Arguments: '{"responseMode":"full"}',
            },
            output: 'thread context',
          },
        },
      }),
      JSON.stringify({
        event: 'result',
        result: { conversation_id: 'session-1', status: 'SUCCESS', response: 'done' },
      }),
    ];
    const turn = summarizeAgyStreamJsonTurn(lines);
    const observed = { sessionId: 'session-1', turn, transportError: null };
    const metadata = { provider: 'google', model: expected.model };
    const allowed = projectAgyNativeTurn('gemini38', { ...metadata }, observed, false, [
      'cat-cafe-collab/cat_cafe_get_thread_context',
    ]);
    assert.equal(allowed.at(-1).errorCode, undefined);
    for (const grants of [[], ['cat-cafe-collab/cat_cafe_post_message']]) {
      const denied = projectAgyNativeTurn('gemini38', { ...metadata }, observed, false, grants);
      assert.equal(denied.at(-1).errorCode, 'AGY_UNEXPECTED_TOOL');
    }
  });

  test('does not turn a failed MCP step into success when upstream result says SUCCESS', () => {
    for (const state of ['ERROR', 'DONE']) {
      const lines = [
        JSON.stringify(init),
        JSON.stringify({
          event: 'step_update',
          step_update: {
            conversation_id: 'session-1',
            step_index: 1,
            state,
            step_type: 'tool',
            tool_name: 'call_mcp_tool',
            tool_info: {
              parameters: {
                ServerName: 'cat-cafe-collab',
                ToolName: 'cat_cafe_get_thread_context',
                Arguments: { responseMode: 'full' },
              },
              error: { type: 'TOOL_ERROR', message: 'fixture transport failed' },
            },
          },
        }),
        JSON.stringify({
          event: 'result',
          result: { conversation_id: 'session-1', status: 'SUCCESS', response: 'All done.' },
        }),
      ];
      const turn = summarizeAgyStreamJsonTurn(lines);
      const messages = projectAgyNativeTurn(
        'gemini38',
        { provider: 'google', model: expected.model },
        { sessionId: 'session-1', turn, transportError: null },
        false,
        ['cat-cafe-collab/cat_cafe_get_thread_context'],
      );
      assert.equal(messages.at(-1).errorCode, 'AGY_TOOL_FAILED');
      assert.equal(messages.find((message) => message.type === 'tool_result').toolResultStatus, 'error');
      assert.ok(!messages.some((message) => message.type === 'text' && message.content === 'All done.'));
    }
  });

  test('keeps the final and failed result when a missing-file observation precedes a successful read', () => {
    const lines = [
      JSON.stringify(init),
      JSON.stringify({
        event: 'step_update',
        step_update: {
          conversation_id: 'session-1',
          step_index: 1,
          state: 'ERROR',
          step_type: 'tool',
          tool_name: 'view_file',
          tool_info: { parameters: { TargetFile: 'missing.ts' }, error: { message: 'File not found' } },
        },
      }),
      JSON.stringify({
        event: 'step_update',
        step_update: {
          conversation_id: 'session-1',
          step_index: 2,
          state: 'DONE',
          step_type: 'tool',
          tool_name: 'view_file',
          tool_info: { parameters: { TargetFile: 'correct.ts' }, output: 'correct source' },
        },
      }),
      JSON.stringify({
        event: 'result',
        result: { conversation_id: 'session-1', status: 'SUCCESS', response: 'Found the source.' },
      }),
    ];
    const turn = summarizeAgyStreamJsonTurn(lines);
    const messages = projectAgyNativeTurn(
      'gemini38',
      { provider: 'google', model: expected.model },
      { sessionId: 'session-1', turn, transportError: null },
      false,
    );
    assert.equal(messages.at(-1).errorCode, undefined);
    assert.equal(messages.find((message) => message.type === 'text').content, 'Found the source.');
    assert.equal(messages.find((message) => message.type === 'tool_result').toolResultStatus, 'error');
  });
});

function projectReadSteps(calls, overrides = {}) {
  const turn = summarizeAgyStreamJsonTurn([
    JSON.stringify(init),
    ...calls.map((call, index) =>
      JSON.stringify({
        event: 'step_update',
        step_update: {
          conversation_id: 'session-1',
          step_index: index + 1,
          step_type: 'tool',
          ...call,
        },
      }),
    ),
    JSON.stringify({
      event: 'result',
      result: { conversation_id: 'session-1', status: 'SUCCESS', response: 'Read observations.', ...overrides.result },
    }),
  ]);
  return projectAgyNativeTurn(
    'gemini38',
    { provider: 'google', model: expected.model },
    { sessionId: 'session-1', turn, transportError: overrides.transportError ?? null },
    overrides.cancelled ?? false,
    ['cat-cafe-collab/cat_cafe_get_thread_context'],
  );
}

const readSuccess = { state: 'DONE', tool_name: 'view_file', tool_info: { output: '4 lines, 153 bytes' } };
const mcpParameters = { ServerName: 'cat-cafe-collab', ToolName: 'cat_cafe_get_thread_context' };
const alphaMissingRead = {
  state: 'ERROR',
  tool_name: 'view_file',
  tool_info: {
    parameters: { AbsolutePath: '/tmp/f325-profile/cwd/hash/README.md' },
    error: {
      message:
        'declaring permissions: cortex tool view_file: convert tool call for permissions: model output error: ' +
        'invalid tool call error (invalid_args) failed to read file: stat /tmp/f325-profile/cwd/hash/README.md: no such file or directory',
    },
  },
};

describe('F325 native missing-file observations', () => {
  test('delivers the final answer with an honest missing-file result regardless of read order', () => {
    for (const calls of [[readSuccess, alphaMissingRead], [alphaMissingRead], [alphaMissingRead, readSuccess]]) {
      const messages = projectReadSteps(calls);
      assert.equal(messages.at(-1).errorCode, undefined);
      assert.equal(messages.find((message) => message.type === 'text')?.content, 'Read observations.');
      const missing = messages.find(
        (message) => message.type === 'tool_result' && message.toolResultStatus === 'error',
      );
      assert.equal(missing.content, alphaMissingRead.tool_info.error.message);
      assert.deepEqual(messages.at(-1).metadata.diagnostics.agyNative.readObservations, [
        { stepIndex: calls.indexOf(alphaMissingRead) + 1, toolName: 'view_file', outcome: 'not_found' },
      ]);
    }
  });

  test('a later successful read cannot pardon permission, unknown or mismatched-path errors', () => {
    for (const message of [
      'permission denied',
      'EACCES: failed to read file',
      'invalid_args: unsafe path',
      alphaMissingRead.tool_info.error.message.replace('/tmp/f325-profile/cwd/hash/README.md', '/tmp/other-file'),
      `${alphaMissingRead.tool_info.error.message}; permission denied`,
    ]) {
      const error = { ...alphaMissingRead, tool_info: { ...alphaMissingRead.tool_info, error: { message } } };
      const messages = projectReadSteps([error, readSuccess]);
      assert.equal(messages.at(-1).errorCode, 'AGY_TOOL_FAILED', message);
      assert.ok(!messages.some((entry) => entry.type === 'text'));
    }
  });

  test('missing-file text without its path or with contradictory file output stays a failure', () => {
    for (const tool_info of [
      { ...alphaMissingRead.tool_info, parameters: {} },
      { ...alphaMissingRead.tool_info, output: 'unexpected file content' },
      { parameters: {}, error: { message: 'File not found' } },
      { parameters: { AbsolutePath: '' }, error: { message: 'File not found' } },
      { parameters: { AbsolutePath: '  ' }, error: { message: 'File not found' } },
    ]) {
      const messages = projectReadSteps([{ ...alphaMissingRead, tool_info }, readSuccess]);
      assert.equal(messages.at(-1).errorCode, 'AGY_TOOL_FAILED');
      assert.ok(!messages.some((entry) => entry.type === 'text'));
    }
  });

  test('missing-file wording does not pardon writes, MCP or other native read tools', () => {
    for (const tool_name of [
      'write_to_file',
      'replace_file_content',
      'call_mcp_tool',
      'list_dir',
      'find_by_name',
      'grep_search',
    ]) {
      for (const message of ['File not found', alphaMissingRead.tool_info.error.message]) {
        const messages = projectReadSteps([
          {
            ...alphaMissingRead,
            tool_name,
            tool_info: {
              parameters: {
                AbsolutePath: alphaMissingRead.tool_info.parameters.AbsolutePath,
                TargetFile: alphaMissingRead.tool_info.parameters.AbsolutePath,
                ...mcpParameters,
              },
              error: { message },
            },
          },
          { ...readSuccess, tool_name, tool_info: { ...readSuccess.tool_info, parameters: mcpParameters } },
        ]);
        assert.equal(messages.at(-1).errorCode, 'AGY_TOOL_FAILED', `${tool_name}: ${message}`);
        assert.ok(!messages.some((entry) => entry.type === 'text'));
      }
    }
  });

  test('an ERROR tool state without an error message still blocks the final answer', () => {
    for (const tool_name of ['view_file', 'list_dir', 'write_to_file']) {
      const messages = projectReadSteps([{ state: 'ERROR', tool_name, tool_info: {} }, readSuccess]);
      assert.equal(messages.at(-1).errorCode, 'AGY_TOOL_FAILED');
      assert.ok(!messages.some((entry) => entry.type === 'text'));
    }
  });

  test('missing-file observations never override denial, cancellation, transport or protocol failure', () => {
    for (const [overrides, code] of [
      [{ result: { denied_actions: [{ action: 'view_file', display_name: 'view_file' }] } }, 'AGY_PERMISSION_DENIED'],
      [{ cancelled: true }, 'AGY_CANCELLED'],
      [{ transportError: 'fixture transport failure' }, 'AGY_NATIVE_FAILED'],
      [{ result: { status: 'ERROR', error: 'fixture provider failure' } }, 'AGY_NATIVE_FAILED'],
    ]) {
      const messages = projectReadSteps([alphaMissingRead], overrides);
      assert.equal(messages.at(-1).errorCode, code);
      assert.ok(!messages.some((entry) => entry.type === 'text'));
    }
  });
});
