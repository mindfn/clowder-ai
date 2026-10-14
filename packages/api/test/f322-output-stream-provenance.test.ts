import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  accumulateMessageOutputText,
  createMessageOutputState,
  materializeMessageOutput,
} from '../src/domains/cats/services/agents/message-output-accumulator.js';
import { createRoutingMessageTransform } from '../src/domains/cats/services/agents/routing/route-helpers.js';
import type { AgentMessage } from '../src/domains/cats/services/types.js';

const observation = {
  provider: 'codex',
  runtimeSessionId: 'native',
  turnId: 'turn',
  nativeId: 'answer',
  channel: 'final' as const,
  complete: true,
  textMode: 'replace' as const,
};
const input: AgentMessage = {
  type: 'text',
  catId: 'codex61-sol' as AgentMessage['catId'],
  timestamp: 1,
  invocationId: 'child',
  content: '正文。\n{',
  outputMessage: observation,
};

test('a deferred flush retains its unique native provenance without redefining native mode', () => {
  const transform = createRoutingMessageTransform();
  const prefix = transform.transform(input)[0];
  assert.equal(prefix.content, '正文。');
  const flushed = transform.transform({ type: 'done', catId: input.catId, timestamp: 2 })[0];
  assert.equal(flushed.content, '\n{');
  assert.deepEqual(flushed.outputMessage, observation);
  assert.equal(flushed.invocationId, 'child');
  assert.deepEqual(transform.outputFactsFor?.(prefix), { complete: false, changed: false });
  assert.deepEqual(transform.outputFactsFor?.(flushed), { mode: 'append', complete: true, changed: false });
});

test('a buffer spanning different native identities cannot attribute composed text to either one', () => {
  const transform = createRoutingMessageTransform();
  transform.transform(input);
  const second = transform.transform({
    ...input,
    content: 'still pending',
    outputMessage: { ...observation, nativeId: 'other' },
  });
  const final = transform.transform({ type: 'done', catId: input.catId, timestamp: 3 });
  for (const message of [...second, ...final].filter((value) => value.type === 'text')) {
    assert.equal(message.outputMessage, undefined);
  }
});

test('buffered native completion becomes available only after its final public fragment', () => {
  const transform = createRoutingMessageTransform();
  let state = createMessageOutputState({ threadId: 'thread', catId: 'codex61-sol', turnInvocationId: 'child' });
  const first = transform.transform(input)[0];
  state = accumulateMessageOutputText(state, {
    content: first.content ?? '',
    outputMessage: first.outputMessage,
    fragment: transform.outputFactsFor(first),
  });
  assert.equal(materializeMessageOutput(state).layout.status, 'unavailable');
  const last = transform.transform({ type: 'done', timestamp: 2 })[0];
  state = accumulateMessageOutputText(state, {
    content: last.content ?? '',
    outputMessage: last.outputMessage,
    fragment: transform.outputFactsFor(last),
  });
  assert.equal(materializeMessageOutput(state).content, input.content);
  assert.equal(materializeMessageOutput(state).layout.status, 'available');
});

test('a sanitizer rewrite preserves readable text but cannot prove complete native ranges', () => {
  const transform = createRoutingMessageTransform();
  let state = createMessageOutputState({ threadId: 'thread', catId: 'codex61-sol', turnInvocationId: 'child' });
  const messages = [
    ...transform.transform({
      ...input,
      content: 'visible\n{"recipient_name":"functions.exec_command","parameters":{"cmd":"x"}}',
    }),
    ...transform.transform({ type: 'done', timestamp: 2 }),
  ];
  for (const msg of messages.filter((m) => m.type === 'text'))
    state = accumulateMessageOutputText(state, {
      content: msg.content ?? '',
      outputMessage: msg.outputMessage,
      fragment: transform.outputFactsFor(msg),
    });
  assert.equal(materializeMessageOutput(state).layout.status, 'unavailable');
  assert.ok(materializeMessageOutput(state).content.includes('visible'));
});
