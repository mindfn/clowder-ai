import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { homeWorkFixture as fixture } from './helpers/f317-live-home-work-fixture.js';

test('ordinary empty-args callback selects a Host-issued publication and consumes the exact version through HomeHub', async () => {
  const f = await fixture();
  try {
    const result = await f.request();
    assert.equal(result.statusCode, 200);
    assert.equal(result.json().status, 'applied');
    assert.equal(f.inputs[0].ownerRequest, '打开伙伴刚交的回家清单第2版');
    assert.equal(f.inputs[0].candidates[0].label, f.candidate.label);
    assert.match(f.inputs[0].candidates[0].id, /^work-[a-f0-9]{64}$/);
    assert.equal(f.scopes[0].catId, 'codex61-sol');
    assert.equal(f.scopes[0].callId, f.call.id);
    assert.equal(f.resolves(), 1);
    assert.deepEqual((f.grants[0] as { action: unknown }).action, {
      kind: 'publication',
      source: f.source,
      artifact: f.artifact,
    });
    assert.deepEqual(f.records, ['applied']);
  } finally {
    await f.close();
  }
});

test('production C source supplies only cat-readable original publications to the ordinary owner voice path', async () => {
  const f = await fixture(true);
  try {
    assert.equal((await f.voice(['打开伙伴刚交的回家清单', '第2版'])).json().status, 'applied');
    assert.equal(f.inputs[0].candidates.filter((candidate) => candidate.id.startsWith('work-')).length, 1);
    assert.match(f.inputs[0].candidates[0].label, /回家清单.png.*第2版/);
    assert.ok(!JSON.stringify(f.inputs).includes('不应暴露的私密标题'));
    assert.deepEqual((f.grants[0] as { action: unknown }).action, {
      kind: 'publication',
      source: f.source,
      artifact: f.artifact,
    });
  } finally {
    await f.close();
  }
});

test('production C source rechecks cat permission at owner-window consume', async () => {
  const f = await fixture(true);
  try {
    f.consume(async () => f.revokePublication());
    assert.equal((await f.request()).json().status, 'blocked');
    assert.deepEqual(f.grants, [{ kind: 'blocked' }]);
  } finally {
    await f.close();
  }
});

test('complete committed same-call owner utterance reaches Jev unchanged; foreign voice has no request', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.voice(['打开伙伴刚交的回家清单', '第2版'])).json().status, 'applied');
    assert.equal(f.inputs[0].ownerRequest, '打开伙伴刚交的回家清单第2版');
  } finally {
    await f.close();
  }
  const foreign = await fixture();
  try {
    assert.equal((await foreign.voice(['打开回家清单'], 'other-call')).json().status, 'unavailable');
    assert.deepEqual(foreign.inputs, []);
    assert.deepEqual(foreign.grants, []);
  } finally {
    await foreign.close();
  }
});

for (const boundary of ['selection', 'consume'] as const)
  test(`source permission lost at ${boundary} prevents opening despite a forged applied ACK`, async () => {
    const f = await fixture();
    try {
      if (boundary === 'selection') f.select(async () => f.hide());
      else f.consume(async () => f.hide());
      const result = (await f.request()).json();
      assert.equal(result.status, boundary === 'selection' ? 'stale' : 'blocked');
      assert.ok(f.grants.every((grant) => (grant as { kind: string }).kind === 'blocked'));
    } finally {
      await f.close();
    }
  });

test('new owner speech cancels a publication selected from the previous request', async () => {
  const f = await fixture();
  try {
    f.select(async () => {
      await f.call.sendText('先别打开', randomUUID());
    });
    assert.equal((await f.request()).json().status, 'unconfirmed');
    assert.equal(f.resolves(), 0);
    assert.deepEqual(f.grants, []);
  } finally {
    await f.close();
  }
});

test('a different displayed version remains unconfirmed', async () => {
  const f = await fixture();
  try {
    f.wrongVersion();
    assert.equal((await f.request()).json().status, 'unconfirmed');
    assert.equal(f.resolves(), 1);
  } finally {
    await f.close();
  }
});

test('conversation without an explicit open request and an ambiguous version do not open works', async () => {
  const f = await fixture();
  try {
    f.choose('NONE');
    assert.equal((await f.request('聊聊伙伴刚交的回家清单')).json().status, 'none');
    f.choose('ASK');
    assert.equal((await f.request('打开某一版')).json().status, 'ask');
    assert.deepEqual(f.grants, []);
  } finally {
    await f.close();
  }
});
