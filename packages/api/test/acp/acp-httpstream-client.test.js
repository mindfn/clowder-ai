/**
 * AcpHttpStreamClient unit tests using a mock child process and local HTTP server.
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { PassThrough } from 'node:stream';
import { afterEach, describe, it, mock } from 'node:test';

const { AcpHttpStreamClient } = await import(
  '../../dist/domains/cats/services/agents/providers/acp/AcpHttpStreamClient.js'
);

const INIT_RESULT = {
  protocolVersion: 1,
  authMethods: [],
  agentInfo: { name: 'http-acp', title: 'HTTP ACP Test Agent', version: '1.0.0' },
  agentCapabilities: { loadSession: true },
};

function createMockChild() {
  const agentStdout = new PassThrough();
  const agentStderr = new PassThrough();
  const clientStdin = new PassThrough();
  const ee = new EventEmitter();
  const child = {
    pid: 12345,
    stdin: clientStdin,
    stdout: agentStdout,
    stderr: agentStderr,
    killed: false,
    kill: mock.fn(() => {
      child.killed = true;
      agentStdout.end();
      agentStderr.end();
      ee.emit('exit', 0, null);
      return true;
    }),
    on: ee.on.bind(ee),
    once: ee.once.bind(ee),
    removeListener: ee.removeListener.bind(ee),
  };
  return { child, agentStdout };
}

function startJsonRpcServer(handler) {
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const response = handler(message, res);
    if (response === undefined) return;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(`${JSON.stringify(response)}\n`);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function serverPort(server) {
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return address.port;
}

describe('AcpHttpStreamClient', () => {
  let client = null;
  let server = null;

  afterEach(async () => {
    if (client) {
      await client.close();
      client = null;
    }
    if (server) {
      await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
      server = null;
    }
  });

  it('initializes when stdout port discovery line closes readline after match', async () => {
    const seenMethods = [];
    server = await startJsonRpcServer((message) => {
      seenMethods.push(message.method);
      if (message.method === 'initialize') {
        return { jsonrpc: '2.0', id: message.id, result: INIT_RESULT };
      }
      return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'not found' } };
    });
    const { child, agentStdout } = createMockChild();
    const port = serverPort(server);

    client = new AcpHttpStreamClient({
      command: 'fake-http-acp',
      args: [],
      cwd: '/tmp',
      spawnFn: () => {
        setImmediate(() => agentStdout.write(`Listening on port ${port}\n`));
        return child;
      },
      portDiscoveryTimeoutMs: 500,
    });

    const result = await client.initialize();

    assert.equal(result.agentInfo.name, 'http-acp');
    assert.deepEqual(seenMethods, ['initialize']);
  });

  it('rejects prompt streams that close before the final JSON-RPC response', async () => {
    server = await startJsonRpcServer((message, res) => {
      if (message.method === 'initialize') {
        return { jsonrpc: '2.0', id: message.id, result: INIT_RESULT };
      }
      if (message.method === 'session/new') {
        return { jsonrpc: '2.0', id: message.id, result: { sessionId: 'http-session' } };
      }
      if (message.method === 'session/prompt') {
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        res.write(
          `${JSON.stringify({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 'http-session',
              update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'partial' } },
            },
          })}\n`,
        );
        res.end();
        return undefined;
      }
      return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'not found' } };
    });
    const { child, agentStdout } = createMockChild();
    const port = serverPort(server);

    client = new AcpHttpStreamClient({
      command: 'fake-http-acp',
      args: [],
      cwd: '/tmp',
      spawnFn: () => {
        setImmediate(() => agentStdout.write(`Listening on port ${port}\n`));
        return child;
      },
      portDiscoveryTimeoutMs: 500,
    });

    await client.initialize();
    const session = await client.newSession();
    const events = [];
    let caught = null;
    try {
      for await (const event of client.promptStream(session.sessionId, 'hello')) events.push(event);
    } catch (err) {
      caught = err;
    }

    assert.equal(events.length, 1);
    assert.equal(events[0].update.sessionUpdate, 'agent_message_chunk');
    assert.ok(caught, 'Expected truncated prompt stream to reject');
    assert.match(caught.message, /closed before final prompt response/);
  });
});
