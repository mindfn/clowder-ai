import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { _resetServiceHooks, fireServiceEvent, onServiceEvent } from '../dist/domains/services/service-hooks.js';

describe('service-hooks', () => {
  afterEach(() => {
    _resetServiceHooks();
  });

  it('fires registered hook and unregisters on success', async () => {
    let runs = 0;
    onServiceEvent('svc-a', 'started', () => {
      runs += 1;
    });
    await fireServiceEvent('svc-a', 'started');
    assert.equal(runs, 1);
    await fireServiceEvent('svc-a', 'started');
    assert.equal(runs, 1, 'second fire should not re-run unregistered hook');
  });

  it('retains hook across fires when registration thrown', async () => {
    let attempts = 0;
    onServiceEvent('svc-b', 'started', () => {
      attempts += 1;
      if (attempts === 1) throw new Error('first try fails');
    });
    await fireServiceEvent('svc-b', 'started');
    assert.equal(attempts, 1);
    await fireServiceEvent('svc-b', 'started');
    assert.equal(attempts, 2, 'failed hook must re-run on next fire');
  });

  it('preserves hooks registered DURING in-flight dispatch (codex P2 3249229014)', async () => {
    let firstRan = 0;
    let lateRan = 0;
    let lateReceivedAt = -1;

    onServiceEvent('svc-c', 'started', async () => {
      firstRan += 1;
      // Register a second hook while still awaiting in the first one.
      // Before the fix, this hook would be silently dropped by the
      // hooks.set(k, survivors) overwrite at end of fireServiceEvent.
      onServiceEvent('svc-c', 'started', () => {
        lateRan += 1;
        lateReceivedAt = firstRan;
      });
      await new Promise((res) => setTimeout(res, 5));
    });

    await fireServiceEvent('svc-c', 'started');
    // late hook scheduled via microtask — drain it
    await new Promise((res) => setTimeout(res, 10));

    assert.equal(firstRan, 1, 'first hook fires exactly once');
    assert.equal(lateRan, 1, 'late-registered hook must fire (not dropped by survivors overwrite)');
    assert.equal(lateReceivedAt, 1, 'late hook fires after the first hook completes');
  });

  it('preserves late-registered hook even when first hook unregisters cleanly', async () => {
    let lateRan = 0;
    onServiceEvent('svc-d', 'started', async () => {
      onServiceEvent('svc-d', 'started', () => {
        lateRan += 1;
      });
      await new Promise((res) => setImmediate(res));
    });

    await fireServiceEvent('svc-d', 'started');
    await new Promise((res) => setTimeout(res, 10));

    assert.equal(lateRan, 1, 'late hook must not be dropped by hooks.delete when survivors=[]');
  });
});
