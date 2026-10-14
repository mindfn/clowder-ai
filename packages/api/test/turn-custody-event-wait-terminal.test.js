/**
 * F167 — a terminal event-wait outcome is self-settling.
 *
 * `openStructured()` used to return covered_active for EVERY event_wait wake, so the
 * stop gate demanded a fresh structured transition (re-hold / handoff / new wait) even
 * when the wake only reported that its wait had already ended (PR closed, deadline hit).
 * There is nothing left to continue on a closed subject, so the gate could never be
 * satisfied legitimately.
 *
 * The carrier only holds `outcomeId = wait:<subjectRef>:g<generation>:<reason>`. Every
 * carrier here is built through the REAL producer (see the fixture), so a drift in the
 * outcomeId format fails these tests instead of silently turning the verdict off.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { waitTerminationReasonSchema } from '@cat-cafe/shared';
import { waitDispositionEventSourceId } from '../dist/domains/ball-custody/event-wait-events.js';
import { TurnCustodyProjectionService } from '../dist/domains/ball-custody/TurnCustodyProjectionService.js';
import { turnCustodyProjectionReason } from '../dist/infrastructure/telemetry/turn-custody-shadow-telemetry.js';
import { realWaitWake, wakeWithOutcomeId } from './helpers/event-wait-terminal-fixture.js';

const HOLDER = 'codex-sol';
const ids = { holderCatId: HOLDER, subjectKey: 'ball:thread:thread-event-wait' };

const wakeFor = (reason, subjectRef) => realWaitWake(reason, { ...ids, ...(subjectRef ? { subjectRef } : {}) });

/** The custody event the holder's completion writes for a wake's exact (wait, outcome). */
const waitCompletion = (wake, overrides = {}) => {
  const { waitId, outcomeId } = wake.waitContinuationCarrier;
  return {
    kind: 'ball.wait_dispositioned',
    sourceEventId: waitDispositionEventSourceId({ catId: HOLDER, waitId, outcomeId }),
    payload: {
      catId: HOLDER,
      invocationId: 'inv-1',
      sourceMessageId: 'wake-message-1',
      waitId,
      outcomeId,
      disposition: 'completed',
      ...overrides,
    },
  };
};

function harness({ events = [], projection = { state: 'active', holder: HOLDER } } = {}) {
  const log = [...events];
  const service = new TurnCustodyProjectionService({
    ballCustodyProjectionStore: { get: async () => projection },
    ballCustodyEventLog: { read: async (_subjectKey, fromSequence = 0) => log.slice(fromSequence) },
  });
  return { service, addEvent: (event) => log.push(event) };
}

describe('F167 terminal event-wait disposition', () => {
  for (const reason of ['subject_terminal', 'expired']) {
    test(`${reason} wake is covered_empty and never blocks the stop gate`, async () => {
      const { service } = harness();
      const opened = await service.open(wakeFor(reason));

      assert.equal(opened.state, 'covered_empty');
      const decision = await service.close(opened);
      assert.equal(decision.state, 'covered_empty');
      assert.equal(decision.shouldBlock, false);
      assert.equal(decision.transitionObserved, false);
    });
  }

  test('the verdict comes from the carrier alone, so a custody-store failure cannot revive the block', async () => {
    const services = [
      new TurnCustodyProjectionService({}),
      new TurnCustodyProjectionService({
        ballCustodyProjectionStore: { get: async () => Promise.reject(new Error('redis unavailable')) },
        ballCustodyEventLog: { read: async () => Promise.reject(new Error('redis unavailable')) },
      }),
    ];
    for (const service of services) {
      const opened = await service.open(wakeFor('subject_terminal'));
      assert.equal(opened.state, 'covered_empty');
      assert.equal((await service.close(opened)).shouldBlock, false);
    }
  });

  test('a terminal wake stays settled even when the ball has since moved to another holder', async () => {
    const { service } = harness({ projection: { state: 'active', holder: 'someone-else' } });
    const opened = await service.open(wakeFor('subject_terminal'));
    assert.equal(opened.state, 'covered_empty');
  });

  test('matched still owes a continuation: blocks until the holder re-holds or hands off', async () => {
    const { service, addEvent } = harness();
    const opened = await service.open(wakeFor('matched'));
    assert.equal(opened.state, 'covered_active');

    const unresolved = await service.close(opened);
    assert.equal(unresolved.shouldBlock, true);
    assert.equal(unresolved.transitionObserved, false);

    addEvent({ kind: 'ball.held', sourceEventId: 'held-1', payload: { catId: HOLDER } });
    const resolved = await service.close(opened);
    assert.equal(resolved.shouldBlock, false);
    assert.equal(resolved.transitionObserved, true);
    assert.equal(resolved.structuredTransitionKind, 'held');
  });

  test('only the two delivered terminals widen: every other recognised reason keeps its obligation', async () => {
    // user_cancel / owner_changed / superseded are `delivery=not_applicable` in every outcome
    // producer, so no wake normally carries them. If one ever does, behave exactly as before.
    const { service } = harness();
    for (const reason of ['user_cancel', 'owner_changed', 'superseded']) {
      const opened = await service.open(wakeFor(reason));
      assert.equal(opened.state, 'covered_active', `${reason} must not be admitted as self-settling`);
      assert.equal((await service.close(opened)).shouldBlock, true);
    }
  });

  test('every wait termination reason has a deliberate verdict, so a new reason cannot default silently', async () => {
    const verdicts = {
      matched: 'covered_active',
      subject_terminal: 'covered_empty',
      expired: 'covered_empty',
      user_cancel: 'covered_active',
      owner_changed: 'covered_active',
      superseded: 'covered_active',
    };
    const { service } = harness();
    for (const reason of waitTerminationReasonSchema.options) {
      assert.ok(reason in verdicts, `new WaitTerminationReason "${reason}" needs an explicit self-settling decision`);
      assert.equal((await service.open(wakeFor(reason))).state, verdicts[reason], reason);
    }
    assert.deepEqual(Object.keys(verdicts).sort(), [...waitTerminationReasonSchema.options].sort());
  });

  test('subjectRefs containing colons parse by their tail, not by splitting', async () => {
    const { service } = harness();
    for (const subjectRef of ['subject:task:0001790865465409-003225-f7ace56f', 'deployment:alpha:web:g1', 'a:b:c:d']) {
      const terminal = await service.open(wakeFor('subject_terminal', subjectRef));
      assert.equal(terminal.state, 'covered_empty', `${subjectRef} subject_terminal`);
      const matched = await service.open(wakeFor('matched', subjectRef));
      assert.equal(matched.state, 'covered_active', `${subjectRef} matched`);
    }
  });

  test('a subjectRef that imitates a terminal suffix cannot launder a matched wake', async () => {
    const { service } = harness();
    // Real reason is `matched`; the lookalike `:g1:subject_terminal` lives inside the subjectRef.
    const forged = await service.open(wakeFor('matched', 'subject:x:g1:subject_terminal'));
    assert.equal(forged.state, 'covered_active');
    assert.equal((await service.close(forged)).shouldBlock, true);
  });

  test('a matched wake whose work is done has a legal terminal: the holder completes exactly this outcome', async () => {
    const wake = wakeFor('matched');
    const { service, addEvent } = harness();
    const opened = await service.open(wake);
    assert.equal(opened.state, 'covered_active');
    assert.equal((await service.close(opened)).shouldBlock, true, 'nothing done yet');

    addEvent(waitCompletion(wake));
    const settled = await service.close(opened);

    assert.equal(settled.shouldBlock, false);
    assert.equal(settled.transitionObserved, true);
    assert.equal(settled.structuredTransitionKind, 'wait_dispositioned');
  });

  test('a completion of a retired obligation still discharges the turn (the holder no longer owns the ball)', async () => {
    const wake = wakeFor('matched');
    const { service, addEvent } = harness();
    const opened = await service.open(wake);

    addEvent(waitCompletion(wake, { retired: true, retiredReason: 'ball_not_held' }));

    const settled = await service.close(opened);
    assert.equal(settled.shouldBlock, false);
    assert.equal(settled.structuredTransitionKind, 'wait_dispositioned');
  });

  test('an exact terminal already on the log settles the wake for any later turn, whoever wrote it', async () => {
    // A successor invocation of a settled wake (re-exposed by the queue, or opened after the ball reopened) must not
    // be handed a fresh obligation whose baseline excludes the terminal that already exists.
    const wake = wakeFor('matched');
    const { service } = harness({ events: [waitCompletion(wake, { invocationId: 'another-invocation' })] });

    const opened = await service.open(wake);

    assert.equal(opened.state, 'covered_empty');
    assert.deepEqual(opened.evidenceRefs, [
      `event_wait:${ids.subjectKey}`,
      `settled:${waitCompletion(wake).sourceEventId}`,
    ]);
    const decision = await service.close(opened);
    assert.equal(decision.shouldBlock, false);
  });

  test('a settled wake stays settled when the subject has resolved or the ball has since reopened', async () => {
    const wake = wakeFor('matched');
    for (const projection of [
      { state: 'resolved', holder: HOLDER },
      { state: 'active', holder: 'someone-else' },
      { state: 'active', holder: HOLDER },
    ]) {
      const { service } = harness({ events: [waitCompletion(wake)], projection });
      const opened = await service.open(wake);
      assert.equal(opened.state, 'covered_empty', JSON.stringify(projection));
    }
  });

  test('only the woken holder, for exactly this wait and outcome, discharges it', async () => {
    const wake = wakeFor('matched');
    const other = wakeFor('matched', 'pr:zts212653/cat-cafe#4000');
    const foreign = [
      waitCompletion(wake, { catId: 'someone-else' }),
      waitCompletion(wake, { outcomeId: other.waitContinuationCarrier.outcomeId }),
      waitCompletion(wake, { waitId: 'another-wait' }),
      { ...waitCompletion(wake), kind: 'ball.hold_dispositioned' },
      { ...waitCompletion(wake), kind: 'ball.dispatch_dispositioned' },
    ];

    // Already on the log when the turn opens: none of them settles THIS wake.
    const early = harness({ events: foreign.map((event, index) => ({ ...event, sourceEventId: `early-${index}` })) });
    const earlyOpened = await early.service.open(wake);
    assert.equal(
      earlyOpened.state,
      'covered_active',
      'a terminal for another wait, outcome, cat or kind settles nothing',
    );

    // Recorded during the turn: none of them discharges it either.
    const { service, addEvent } = harness();
    const opened = await service.open(wake);
    for (const event of foreign) addEvent(event);
    const decision = await service.close(opened);
    assert.equal(decision.shouldBlock, true, 'none of these is this holder completing this wait and outcome');
    assert.equal(decision.transitionObserved, false);
  });

  // #5049 round 2 (codex61-sol): a wake can enter the turn when it is NOT provably live (the subject already resolved,
  // or the ball is in another cat's hands). Then open has no baseline, and the holder's only legal move is a retired
  // terminal. The stop check must still see the terminal that lands DURING the turn: close cannot return early.
  for (const [label, projection] of [
    ['the subject already resolved', { state: 'resolved', holder: HOLDER }],
    ['another cat holds the ball', { state: 'active', holder: 'someone-else' }],
  ]) {
    test(`without a baseline (${label}) a terminal written during the turn still settles it`, async () => {
      const wake = wakeFor('matched');
      const { service, addEvent } = harness({ projection });
      const opened = await service.open(wake);
      assert.equal(opened.state, 'unknown_legacy', 'not provably live: fail closed at open');
      assert.equal(opened.baseline, undefined);
      assert.equal((await service.close(opened)).shouldBlock, true, 'no terminal yet: still blocked');

      addEvent(waitCompletion(wake, { retired: true, retiredReason: 'ball_not_held' }));
      const settled = await service.close(opened);

      assert.equal(settled.shouldBlock, false);
      assert.equal(settled.state, 'covered_empty');
      assert.equal(settled.transitionObserved, true);
      assert.equal(settled.structuredTransitionKind, 'wait_dispositioned');
    });

    test(`without a baseline (${label}) a terminal for another wait, outcome, cat or protocol settles nothing`, async () => {
      const wake = wakeFor('matched');
      const other = wakeFor('matched', 'pr:zts212653/cat-cafe#4000');
      const { service, addEvent } = harness({ projection });
      const opened = await service.open(wake);
      for (const event of [
        waitCompletion(wake, { catId: 'someone-else' }),
        waitCompletion(wake, { outcomeId: other.waitContinuationCarrier.outcomeId }),
        waitCompletion(wake, { waitId: 'another-wait' }),
        { ...waitCompletion(wake), kind: 'ball.hold_dispositioned' },
        { ...waitCompletion(wake), kind: 'ball.dispatch_dispositioned' },
      ]) {
        addEvent(event);
      }

      const decision = await service.close(opened);

      assert.equal(decision.shouldBlock, true);
      assert.equal(decision.transitionObserved, false);
    });
  }

  test('an open that could not read the ledger can still be settled by a terminal close reads', async () => {
    const wake = wakeFor('matched');
    let failReads = true;
    const log = [];
    const service = new TurnCustodyProjectionService({
      ballCustodyProjectionStore: { get: async () => ({ state: 'active', holder: HOLDER }) },
      ballCustodyEventLog: {
        read: async (_subjectKey, from = 0) => {
          if (failReads) throw new Error('redis unavailable');
          return log.slice(from);
        },
      },
    });
    const opened = await service.open(wake);
    assert.equal(opened.state, 'unknown_legacy');
    assert.deepEqual(opened.evidenceRefs, ['unknown:query_failed']);

    failReads = false;
    log.push(waitCompletion(wake));
    const settled = await service.close(opened);

    assert.equal(settled.shouldBlock, false);
    assert.equal(settled.structuredTransitionKind, 'wait_dispositioned');
  });

  test('an unreadable outcome gets no locator: it fails closed for the whole turn, whatever the log holds', async () => {
    const wake = wakeWithOutcomeId('garbage', ids);
    const { service, addEvent } = harness();
    const opened = await service.open(wake);
    assert.equal(opened.state, 'unknown_legacy');
    addEvent(waitCompletion(wake));

    assert.equal((await service.close(opened)).shouldBlock, true);
  });

  test('a wait completion cannot discharge a wake of another protocol, whatever fields it carries', async () => {
    // hold / dispatch baselines carry no waitId / outcomeId, so only the protocol fence keeps a field-less
    // completion from "matching" them (undefined === undefined).
    const holdWake = { kind: 'structured', protocol: 'hold', subjectKey: ids.subjectKey, holderCatId: HOLDER };
    const dispatchWake = {
      kind: 'structured',
      protocol: 'dispatch',
      subjectKey: ids.subjectKey,
      holderCatId: HOLDER,
      handoff: { sourceEventId: `route:m1:${HOLDER}`, messageId: 'm1', fromCatId: 'sonnet' },
    };
    const handoff = {
      kind: 'ball.handed',
      sourceEventId: `route:m1:${HOLDER}`,
      payload: { toCatId: HOLDER, fromCatId: 'sonnet' },
    };
    for (const [wake, events] of [
      [{ ...holdWake, sourceMessageId: 'm1', taskId: 't1' }, []],
      [dispatchWake, [handoff]],
    ]) {
      const { service, addEvent } = harness({ events });
      const opened = await service.open(wake);
      assert.equal(opened.state, 'covered_active', wake.protocol);

      addEvent({ kind: 'ball.wait_dispositioned', sourceEventId: 'x', payload: { catId: HOLDER } });

      const decision = await service.close(opened);
      assert.equal(decision.transitionObserved, false, wake.protocol);
      assert.equal(decision.shouldBlock, true, wake.protocol);
    }
  });

  test('a self-settling wake stays settled by its carrier alone, whatever completion events exist', async () => {
    const wake = wakeFor('subject_terminal');
    const { service, addEvent } = harness();
    const opened = await service.open(wake);
    addEvent(waitCompletion(wake));

    const decision = await service.close(opened);
    assert.equal(decision.state, 'covered_empty', 'self-settling stays settled by the carrier alone');
    assert.equal(decision.shouldBlock, false);
  });

  test('a malformed or unrecognised outcome fails closed instead of guessing', async () => {
    const { service } = harness();
    const cases = [
      'garbage',
      'wait:pr:zts212653/cat-cafe#3300:g4:totally_new_reason',
      'wait:pr:zts212653/cat-cafe#3300:g4:',
      'wait:pr:zts212653/cat-cafe#3300:gX:subject_terminal',
      'wait:pr:zts212653/cat-cafe#3300:subject_terminal',
      'wait:pr:zts212653/cat-cafe#3300:g0:subject_terminal',
      'xwait:pr:zts212653/cat-cafe#3300:g4:subject_terminal',
      ' wait:pr:zts212653/cat-cafe#3300:g4:subject_terminal',
      'wait:pr:zts212653/cat-cafe#3300:g4:subject_terminal\n',
      'wait::g4:subject_terminal',
    ];
    for (const outcomeId of cases) {
      const opened = await service.open(wakeWithOutcomeId(outcomeId, ids));
      assert.equal(opened.state, 'unknown_legacy', JSON.stringify(outcomeId));
      assert.deepEqual(opened.evidenceRefs, ['unknown:event_wait_outcome_unrecognized']);
      // Bounded metric vocabulary: an unreadable carrier must surface as its own reason, not as `other`.
      assert.equal(turnCustodyProjectionReason(opened.evidenceRefs), 'event_wait_outcome_unrecognized');
      assert.equal((await service.close(opened)).shouldBlock, true, JSON.stringify(outcomeId));
    }
  });
});
