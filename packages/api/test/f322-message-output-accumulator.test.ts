import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  accumulateMessageOutputText,
  accumulateMessageOutputTool,
  createMessageOutputState,
  materializeMessageOutput,
} from '../src/domains/cats/services/agents/message-output-accumulator.js';

const owner = { threadId: 'thread', catId: 'codex61-sol', turnInvocationId: 'child' };
const native = (nativeId: string, channel = 'commentary', complete = true, textMode = 'replace') => ({
  provider: 'codex',
  runtimeSessionId: 'native',
  turnId: 'native-turn',
  nativeId,
  channel,
  complete,
  textMode,
});

test('the message-owned accumulator preserves native/tool order and owns only ranges of one body', () => {
  let state = createMessageOutputState(owner);
  state = accumulateMessageOutputText(state, { content: '过程。', outputMessage: native('process') });
  state = accumulateMessageOutputTool(state, 'api-tool-instance', 'child');
  state = accumulateMessageOutputText(state, {
    content: '\n\n回答。',
    outputMessage: { ...native('answer', 'final'), displayPrefixLength: 2 },
  });
  const result = materializeMessageOutput(state);
  assert.equal(result.content, '过程。\n\n回答。');
  assert.equal(result.layout?.status, 'available');
  if (result.layout?.status !== 'available') return;
  assert.deepEqual(result.layout.owner, owner);
  assert.deepEqual(
    result.layout.order.map((ref) => ref.kind),
    ['run', 'tool', 'run'],
  );
  assert.equal(result.layout.order[1].kind === 'tool' && result.layout.order[1].toolEventId, 'api-tool-instance');
  assert.deepEqual(
    result.layout.runs.map((run) => [run.start, run.end]),
    [
      [0, 3],
      [3, 8],
    ],
  );
  assert.ok(
    result.layout.runs.every((run) => !('text' in run)),
    'no second durable body',
  );
});

test('native append→replace updates its unsealed run without erasing earlier outputs or tools', () => {
  let state = createMessageOutputState(owner);
  state = accumulateMessageOutputText(state, { content: '过程。', outputMessage: native('process') });
  state = accumulateMessageOutputTool(state, 'tool', 'child');
  state = accumulateMessageOutputText(state, {
    content: '旧',
    outputMessage: native('answer', 'final', false, 'append'),
  });
  state = accumulateMessageOutputText(state, {
    content: '快照。',
    outputMessage: native('answer', 'final', false, 'append'),
  });
  state = accumulateMessageOutputText(state, {
    content: '新回答。',
    outputMessage: native('answer', 'final', true, 'replace'),
  });
  const result = materializeMessageOutput(state);
  assert.equal(result.content, '过程。\n\n新回答。');
  assert.equal(result.layout?.status, 'available');
});

test('unknown text around a real tool boundary stays whole but cannot enable classification', () => {
  let state = createMessageOutputState(owner);
  state = accumulateMessageOutputText(state, { content: '查前。' });
  state = accumulateMessageOutputTool(state, 'tool', 'child');
  state = accumulateMessageOutputText(state, { content: '' });
  state = accumulateMessageOutputText(state, { content: '查后。' });
  const result = materializeMessageOutput(state);
  assert.equal(result.content, '查前。\n\n查后。');
  assert.equal(result.layout?.status, 'unavailable');
});

test('an exact completed snapshot retry is idempotent, including tool references', () => {
  const input = { content: '回答。', outputMessage: native('answer', 'final') };
  let state = accumulateMessageOutputText(createMessageOutputState(owner), input);
  state = accumulateMessageOutputTool(state, 'tool', 'child');
  state = accumulateMessageOutputTool(state, 'tool', 'child');
  state = accumulateMessageOutputText(state, input);
  assert.equal(materializeMessageOutput(state).content, '回答。');
  assert.equal(materializeMessageOutput(state).layout.status, 'available');
});

for (const [name, later] of [
  ['complete then changed snapshot', { content: 'changed', outputMessage: native('answer', 'final') }],
  ['same identity with changed channel', { content: 'changed', outputMessage: native('answer', 'commentary') }],
] as const) {
  test(`${name} keeps public text but never enables classification`, () => {
    let state = accumulateMessageOutputText(createMessageOutputState(owner), {
      content: 'original',
      outputMessage: native('answer', 'final'),
    });
    state = accumulateMessageOutputText(state, later);
    const result = materializeMessageOutput(state);
    assert.ok(result.content.includes('original') && result.content.includes('changed'));
    assert.equal(result.layout.status, 'unavailable');
    assert.equal(result.layout.status === 'unavailable' && result.layout.reason, 'conflict');
  });
}

test('a tool seals the current run against a late replacement', () => {
  let state = accumulateMessageOutputText(createMessageOutputState(owner), {
    content: 'original',
    outputMessage: native('answer', 'final', false),
  });
  state = accumulateMessageOutputTool(state, 'tool', 'child');
  state = accumulateMessageOutputText(state, { content: 'changed', outputMessage: native('answer', 'final') });
  const result = materializeMessageOutput(state);
  assert.equal(result.content, 'original\n\nchanged');
  assert.equal(result.layout.status === 'unavailable' && result.layout.reason, 'conflict');
});

for (const mode of [null, 'bogus', {}, 0, false]) {
  test(`invalid explicit native mode ${JSON.stringify(mode)} preserves body and fails closed`, () => {
    const state = accumulateMessageOutputText(createMessageOutputState(owner), {
      content: 'do not hide',
      outputMessage: { ...native('answer', 'final'), textMode: mode },
    });
    const result = materializeMessageOutput(state);
    assert.equal(result.content, 'do not hide');
    assert.equal(result.layout.status === 'unavailable' && result.layout.reason, 'conflict');
  });
}

test('native mode never borrows the outer whole-bubble replace mode', () => {
  let state = accumulateMessageOutputText(createMessageOutputState(owner), {
    content: '前',
    outputMessage: native('answer', 'final', false, 'append'),
  });
  state = accumulateMessageOutputText(state, {
    content: '后。',
    textMode: 'replace',
    outputMessage: { ...native('answer', 'final'), textMode: undefined },
  });
  assert.equal(materializeMessageOutput(state).content, '前后。');
  const roundTrip = JSON.parse(JSON.stringify(state));
  assert.deepEqual(materializeMessageOutput(roundTrip), materializeMessageOutput(state));
});

test('genuine legacy whole-body replacement resets content and invalidates layout', () => {
  let state = accumulateMessageOutputText(createMessageOutputState(owner), {
    content: 'old',
    outputMessage: native('answer', 'final'),
  });
  state = accumulateMessageOutputText(state, { content: 'canonical replacement', textMode: 'replace' });
  const result = materializeMessageOutput(state);
  assert.equal(result.content, 'canonical replacement');
  assert.equal(result.layout.status === 'unavailable' && result.layout.reason, 'whole_body_replaced');
});

test('surrogate fragments normalize only the published snapshot and keep UTF-16 ranges', () => {
  let state = accumulateMessageOutputText(createMessageOutputState(owner), {
    content: '\uD83D',
    outputMessage: native('answer', 'final', false, 'append'),
  });
  assert.equal(materializeMessageOutput(state).content, '\uFFFD');
  state = accumulateMessageOutputText(state, {
    content: '\uDE3A。',
    outputMessage: native('answer', 'final', true, 'append'),
  });
  const result = materializeMessageOutput(state);
  assert.equal(result.content, '😺。');
  assert.equal(result.layout.contentRevision.length, 3);
  assert.equal(result.layout.status === 'available' && result.layout.runs[0].end, 3);
});

for (const suffix of ['', '\n', '\n\n']) {
  test(`a tool separator adds only missing blank lines (${suffix.length})`, () => {
    let state = accumulateMessageOutputText(createMessageOutputState(owner), { content: `before${suffix}` });
    state = accumulateMessageOutputTool(state, 'use', 'child');
    state = accumulateMessageOutputTool(state, 'result', 'child');
    state = accumulateMessageOutputText(state, { content: 'after' });
    assert.equal(materializeMessageOutput(state).content, 'before\n\nafter');
  });
}

test('a genuine empty whole-body replacement is not ignored as an empty fragment', () => {
  let state = accumulateMessageOutputText(createMessageOutputState(owner), { content: 'old whole body' });
  state = accumulateMessageOutputText(state, { content: '', textMode: 'replace' });
  assert.equal(materializeMessageOutput(state).content, '');
});

test('an event instance reused by a different execution invalidates its order evidence', () => {
  let state = accumulateMessageOutputText(createMessageOutputState(owner), {
    content: 'answer',
    outputMessage: native('answer', 'final'),
  });
  state = accumulateMessageOutputTool(state, 'instance', 'child');
  state = accumulateMessageOutputTool(state, 'instance', 'other-child');
  assert.equal(materializeMessageOutput(state).layout.status, 'unavailable');
});

test('an explicitly malformed completion observation cannot later acquire complete evidence', () => {
  let state = accumulateMessageOutputText(createMessageOutputState(owner), {
    content: 'old',
    outputMessage: { ...native('answer', 'final'), complete: 'true' },
  });
  state = accumulateMessageOutputText(state, { content: 'new', outputMessage: native('answer', 'final') });
  const result = materializeMessageOutput(state);
  assert.equal(result.layout.status === 'unavailable' && result.layout.reason, 'conflict');
});
