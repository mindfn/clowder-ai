import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { BallCustodyIngest } from '../dist/domains/ball-custody/BallCustodyIngest.js';
import { BallCustodyProjector } from '../dist/domains/ball-custody/BallCustodyProjector.js';
import { buildHandedEvent } from '../dist/domains/ball-custody/ball-custody-events.js';

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function memoryLog() {
  const events = [];
  const seen = new Set();
  return {
    append: async (event) => {
      if (seen.has(event.sourceEventId)) return { appended: false, sequence: -1 };
      const sequence = events.filter((row) => row.subjectKey === event.subjectKey).length;
      seen.add(event.sourceEventId);
      events.push(event);
      return { appended: true, sequence };
    },
    appendFenced: async (event, expectedSequence) => {
      if (seen.has(event.sourceEventId)) return { outcome: 'duplicate' };
      const actualSequence = events.filter((row) => row.subjectKey === event.subjectKey).length;
      if (actualSequence !== expectedSequence) return { outcome: 'conflict', actualSequence };
      seen.add(event.sourceEventId);
      events.push(event);
      return { outcome: 'appended', sequence: actualSequence };
    },
    read: async (subject) => events.filter((event) => event.subjectKey === subject),
    listSubjects: async () => [...new Set(events.map((event) => event.subjectKey))],
  };
}

function memoryStore() {
  const projections = new Map();
  return {
    get: async (subject) => (projections.has(subject) ? structuredClone(projections.get(subject)) : null),
    save: async (projection) => {
      projections.set(projection.subjectKey, structuredClone(projection));
    },
    delete: async (subject) => {
      projections.delete(subject);
    },
    listSubjectKeys: async () => [...projections.keys()],
  };
}

function handed(toCatId, messageId, threadId = 'thread-1') {
  return buildHandedEvent({ toCatId, messageId, threadId, at: messageId === 'first' ? 100 : 200 });
}

function wrongHolderDisposition() {
  return {
    sourceEventId: 'dispatch-disposition:wrong-holder',
    subjectKey: 'ball:thread:thread-1',
    kind: 'ball.dispatch_dispositioned',
    classification: 'state-changing',
    payload: { catId: 'codex', sourceMessageId: 'first', disposition: 'completed' },
    at: 200,
  };
}

function setup() {
  const log = memoryLog();
  const store = memoryStore();
  const projector = new BallCustodyProjector(log, store);
  return { log, store, projector, ingest: new BallCustodyIngest(log, projector) };
}

describe('Ball custody projection acceptance is independent of append success', () => {
  it('apply returns accepted only after the projection was saved', async () => {
    const { store, projector } = setup();
    const entered = deferred();
    const release = deferred();
    const save = store.save;
    store.save = async (projection) => {
      entered.resolve();
      await release.promise;
      await save(projection);
    };
    let finished = false;
    const applying = projector.apply(handed('opus', 'first')).then((result) => {
      finished = true;
      return result;
    });
    await entered.promise;
    assert.equal(finished, false);
    release.resolve();
    assert.deepEqual(await applying, { accepted: true });
    assert.equal((await store.get('ball:thread:thread-1')).holder, 'opus');
  });

  it('apply reports a rejected transition without changing the live holder', async () => {
    const { projector, store } = setup();
    await projector.apply(handed('opus', 'first'));
    assert.deepEqual(await projector.apply(wrongHolderDisposition()), { accepted: false });
    const projection = await store.get('ball:thread:thread-1');
    assert.equal(projection.state, 'active');
    assert.equal(projection.holder, 'opus');
    assert.equal(projection.appliedEventCount, 1);
    assert.equal(projection.lastRejectedEvent.sourceEventId, 'dispatch-disposition:wrong-holder');
  });

  it('recordFenced distinguishes an appended but rejected disposition', async () => {
    const { ingest, store, log } = setup();
    await ingest.record(handed('opus', 'first'));
    assert.deepEqual(await ingest.recordFenced(wrongHolderDisposition(), 1), {
      outcome: 'appended',
      sequence: 1,
      projection: 'rejected',
    });
    assert.equal((await log.read('ball:thread:thread-1')).length, 2);
    assert.equal((await store.get('ball:thread:thread-1')).holder, 'opus');
  });

  it('acceptance does not require a state change; informational rejection remains rejected', async () => {
    const { projector, store } = setup();
    await projector.apply(handed('opus', 'first'));
    const heartbeat = {
      sourceEventId: 'heartbeat',
      subjectKey: 'ball:thread:thread-1',
      kind: 'invocation.heartbeat',
      classification: 'informational',
      payload: {},
      at: 150,
    };
    assert.deepEqual(await projector.apply(heartbeat), { accepted: true });
    assert.deepEqual(await projector.apply({ ...heartbeat, sourceEventId: 'wake', kind: 'ball.wake_sent', at: 200 }), {
      accepted: false,
    });
    const projection = await store.get(heartbeat.subjectKey);
    assert.equal(projection.state, 'active');
    assert.equal(projection.appliedEventCount, 2);
    assert.equal(projection.lastRejectedEvent, null);
  });

  it('recordFenced reports accepted, preserving duplicate precedence and the sequence fence', async () => {
    const { ingest, store, log } = setup();
    const event = handed('opus', 'first');
    assert.deepEqual(await ingest.recordFenced(event, 0), {
      outcome: 'appended',
      sequence: 0,
      projection: 'accepted',
    });
    assert.deepEqual(await ingest.recordFenced(event, 0), { outcome: 'duplicate' });
    assert.deepEqual(await ingest.recordFenced(handed('codex', 'second'), 0), {
      outcome: 'conflict',
      actualSequence: 1,
    });
    assert.equal((await log.read('ball:thread:thread-1')).length, 1);
    assert.equal((await store.get('ball:thread:thread-1')).appliedEventCount, 1);
  });

  it('a legacy void apply result stays unknown, never accepted', async () => {
    const log = memoryLog();
    const ingest = new BallCustodyIngest(log, { apply: async () => {}, rebuild: async () => {} });
    const result = await ingest.recordFenced(handed('opus', 'first'), 0);
    assert.equal(result.outcome, 'appended');
    assert.equal(Object.hasOwn(result, 'projection'), false);
  });

  it('projection save errors reject recordFenced; rebuild repairs from the unchanged event log', async () => {
    const { ingest, store, log } = setup();
    const save = store.save;
    store.save = async () => {
      throw new Error('save unavailable');
    };
    await assert.rejects(ingest.recordFenced(handed('opus', 'first'), 0), /save unavailable/);
    assert.equal((await log.read('ball:thread:thread-1')).length, 1);
    store.save = save;
    await ingest.rebuild('ball:thread:thread-1');
    assert.equal((await store.get('ball:thread:thread-1')).holder, 'opus');
  });
});

describe('Ball custody rebuild shares the process-local subject chain', () => {
  for (const method of ['record', 'recordFenced']) {
    it(`a paused replay cannot overwrite a later ${method} holder`, async () => {
      const { ingest, log, store } = setup();
      const subject = 'ball:thread:thread-1';
      await ingest.record(handed('opus', 'first'));
      const captured = deferred();
      const release = deferred();
      const read = log.read;
      let pause = true;
      log.read = async (key) => {
        const snapshot = await read(key);
        if (key === subject && pause) {
          pause = false;
          captured.resolve();
          await release.promise;
        }
        return snapshot;
      };
      const rebuilding = ingest.rebuild(subject);
      await captured.promise;
      const writing =
        method === 'record'
          ? ingest.record(handed('codex', 'second'))
          : ingest.recordFenced(handed('codex', 'second'), 1);
      // All non-blocked in-memory operations finish in this event-loop turn; no timing sleep.
      await setImmediate();
      release.resolve();
      await Promise.all([rebuilding, writing]);
      const projection = await store.get(subject);
      assert.equal(projection.holder, 'codex', 'the old replay snapshot must not win over the new holder');
      assert.equal(projection.appliedEventCount, 2);
      assert.equal((await log.read(subject)).length, 2, 'rebuild must never append an event');
    });

    it(`rebuild waits for an earlier ${method} projection save`, async () => {
      const { ingest, store } = setup();
      const subject = 'ball:thread:thread-1';
      const entered = deferred();
      const release = deferred();
      const save = store.save;
      const remove = store.delete;
      let pause = true;
      let deleted = false;
      store.save = async (projection) => {
        if (pause) {
          pause = false;
          entered.resolve();
          await release.promise;
        }
        await save(projection);
      };
      store.delete = async (key) => {
        deleted = true;
        await remove(key);
      };
      const writing =
        method === 'record' ? ingest.record(handed('opus', 'first')) : ingest.recordFenced(handed('opus', 'first'), 0);
      await entered.promise;
      const rebuilding = ingest.rebuild(subject);
      await setImmediate();
      const deletedBeforeWriteFinished = deleted;
      release.resolve();
      await Promise.all([writing, rebuilding]);
      assert.equal(deletedBeforeWriteFinished, false, 'rebuild cannot bypass an in-flight projection save');
      assert.equal((await store.get(subject)).appliedEventCount, 1);
    });
  }

  it('a blocked rebuild does not block another subject', async () => {
    const { ingest, store } = setup();
    const entered = deferred();
    const release = deferred();
    const remove = store.delete;
    store.delete = async (subject) => {
      if (subject === 'ball:thread:thread-1') {
        entered.resolve();
        await release.promise;
      }
      await remove(subject);
    };
    const rebuilding = ingest.rebuild('ball:thread:thread-1');
    await entered.promise;
    try {
      const result = await ingest.recordFenced(handed('codex', 'second', 'thread-2'), 0);
      assert.equal(result.outcome, 'appended');
      assert.equal((await store.get('ball:thread:thread-2')).holder, 'codex');
    } finally {
      release.resolve();
      await rebuilding;
    }
  });

  it('a failed rebuild does not poison later writes or rebuilds on the same subject', async () => {
    const { ingest, store } = setup();
    const remove = store.delete;
    store.delete = async () => {
      throw new Error('delete unavailable');
    };
    await assert.rejects(ingest.rebuild('ball:thread:thread-1'), /delete unavailable/);
    store.delete = remove;
    await ingest.record(handed('opus', 'first'));
    await ingest.rebuild('ball:thread:thread-1');
    assert.equal((await store.get('ball:thread:thread-1')).holder, 'opus');
    assert.equal((await store.get('ball:thread:thread-1')).appliedEventCount, 1);
  });

  it('operations already queued behind a failing replay still run in order', async () => {
    const { ingest, log, store } = setup();
    await ingest.record(handed('opus', 'first'));
    const entered = deferred();
    const release = deferred();
    const read = log.read;
    let fail = true;
    log.read = async (subject) => {
      if (fail) {
        fail = false;
        entered.resolve();
        await release.promise;
        throw new Error('replay unavailable');
      }
      return read(subject);
    };
    const failing = assert.rejects(ingest.rebuild('ball:thread:thread-1'), /replay unavailable/);
    await entered.promise;
    const writing = ingest.recordFenced(handed('codex', 'second'), 1);
    const repairing = ingest.rebuild('ball:thread:thread-1');
    release.resolve();
    await Promise.all([failing, writing, repairing]);
    const projection = await store.get('ball:thread:thread-1');
    assert.equal(projection.holder, 'codex');
    assert.equal(projection.appliedEventCount, 2);
  });
});
