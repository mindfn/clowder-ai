import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';

import { handleGenerateNow, handleTriggerNow } from '../../dist/routes/eval-hub.js';
import { setupHarnessFeedback, setupRawArtifacts } from './eval-manual-trigger-fixtures.js';

describe('Eval Manual Trigger Handlers (F192 OQ-21)', () => {
  /** @type {string} */
  let root;

  before(() => {
    root = setupHarnessFeedback();
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // ==========================================================================
  // handleTriggerNow — true wake via late-bound invokeTrigger
  // ==========================================================================
  describe('handleTriggerNow', () => {
    it('returns 503 when invokeTriggerProvider.get() returns null', async () => {
      const result = await handleTriggerNow(
        {
          harnessFeedbackRoot: root,
          invokeTriggerProvider: { get: () => null },
          messageStore: { append: async () => ({ id: 'msg-1' }) },
        },
        { domainId: 'eval:a2a', userId: 'test-user' },
      );
      assert.ok('error' in result);
      assert.equal(result.status, 503);
      assert.match(result.error, /delivery not ready/);
    });

    it('returns 503 when messageStore not provided', async () => {
      const result = await handleTriggerNow(
        {
          harnessFeedbackRoot: root,
          invokeTriggerProvider: {
            get: () => ({ deliver: async () => ({ state: 'started', message: { id: 'msg-manual' } }) }),
          },
        },
        { domainId: 'eval:a2a', userId: 'test-user' },
      );
      assert.ok('error' in result);
      assert.equal(result.status, 503);
      assert.match(result.error, /messageStore/);
    });

    it('returns 400 for unknown domainId', async () => {
      const result = await handleTriggerNow(
        {
          harnessFeedbackRoot: root,
          invokeTriggerProvider: {
            get: () => ({ deliver: async () => ({ state: 'started', message: { id: 'msg-manual' } }) }),
          },
          messageStore: { append: async () => ({ id: 'msg-1' }) },
        },
        { domainId: 'eval:nonexistent', userId: 'test-user' },
      );
      assert.ok('error' in result);
      assert.equal(result.status, 400);
      assert.match(result.error, /eval:nonexistent.*not registered/);
    });

    it('真 wake: calls invokeTrigger.trigger() with correct args and returns 200', async () => {
      const triggerCalls = [];
      const messageStoreCalls = [];

      const result = await handleTriggerNow(
        {
          harnessFeedbackRoot: root,
          invokeTriggerProvider: {
            get: () => ({
              // Admission is the wake: one envelope crosses one seam.
              deliver: async (input) => {
                triggerCalls.push(input);
                return { state: 'started', message: { id: `msg-${input.threadId}` } };
              },
            }),
          },
          messageStore: {
            append: async (msg) => {
              messageStoreCalls.push(msg);
              return { id: `msg-${msg.threadId}` };
            },
          },
        },
        { domainId: 'eval:a2a', userId: 'test-user' },
      );

      assert.ok(!('error' in result), `expected success, got: ${JSON.stringify(result)}`);
      assert.equal(result.ok, true);
      assert.equal(result.domainId, 'eval:a2a');
      assert.equal(result.threadId, 'thread_eval_a2a');
      assert.equal(result.evalCatId, 'codex');
      assert.equal(result.invocationTriggered, true);
      assert.equal(result.triggerOutcome, 'dispatched');
      assert.equal(result.messageId, 'msg-thread_eval_a2a');

      // 砚砚 R0 P1 is structural now: the packet cannot be published without admitting it, so the
      // one envelope IS both the message and the wake — there is no append-only failure mode left.
      assert.equal(triggerCalls.length, 1, 'one envelope, one admission');
      const envelope = triggerCalls[0];
      assert.equal(envelope.threadId, 'thread_eval_a2a');
      assert.equal(envelope.targetCatId, 'codex');
      assert.equal(envelope.ownerUserId, 'test-user');
      assert.match(envelope.content, /manual trigger by test-user/);
      assert.ok(envelope.idempotencyKey, 'and it carries a stable admission identity');
    });

    it('returns success when the thread is busy — admission still settles the wake', async () => {
      const result = await handleTriggerNow(
        {
          harnessFeedbackRoot: root,
          invokeTriggerProvider: {
            get: () => ({ deliver: async () => ({ state: 'already_processing', message: { id: 'msg-busy' } }) }),
          },
          messageStore: { append: async () => ({ id: 'msg-busy' }) },
        },
        { domainId: 'eval:a2a', userId: 'test-user' },
      );
      assert.ok(!('error' in result));
      assert.equal(result.triggerOutcome, 'dispatched', 'admission is the wake');
    });

    // Cloud codex R2 P2 still holds, in a stronger form: a refused admission surfaces as 503 AND
    // publishes nothing — atomic admission leaves no packet in the thread with nobody woken for it.
    it('returns 503 when the Queue refuses the admission, and publishes nothing', async () => {
      const messageStoreCalls = [];
      const result = await handleTriggerNow(
        {
          harnessFeedbackRoot: root,
          invokeTriggerProvider: {
            get: () => ({
              deliver: async (input) => {
                messageStoreCalls.push(input);
                return { state: 'unavailable' };
              },
            }),
          },
          messageStore: { append: async () => ({ id: 'msg-dropped' }) },
        },
        { domainId: 'eval:a2a', userId: 'test-user' },
      );
      assert.ok('error' in result);
      assert.equal(result.status, 503);
      assert.equal(result.error, 'invocation_queue_unavailable');
      assert.match(result.detail, /queue/);
      assert.match(result.detail, /retry/i);
      assert.equal(messageStoreCalls.length, 1, 'admission was attempted');
      assert.equal(
        messageStoreCalls[0].targetCatId !== undefined,
        true,
        'the refused envelope named its member, so nothing was published half-woken',
      );
    });
  });

  // ==========================================================================
  // handleGenerateNow — domain validation order + security + eval:a2a only
  // ==========================================================================
  describe('handleGenerateNow', () => {
    // 砚砚 R1 P2-a: validation order — unknown = 400 (not 501)
    it('returns 400 for unknown domainId (eval:totally-unknown) — NOT 501', async () => {
      const result = await handleGenerateNow(
        { harnessFeedbackRoot: root },
        {
          domainId: 'eval:totally-unknown',
          userId: 'test-user',
          verdictId: 'test',
          snapshotName: 'foo.yaml',
          attributionName: 'bar.yaml',
        },
      );
      assert.ok('error' in result);
      assert.equal(result.status, 400);
      assert.match(result.error, /eval:totally-unknown.*not registered/);
    });

    // 砚砚 R0 P1: 501 unsupported_generator for all registered-but-no-generator domains
    it('returns 501 unsupported_generator for all non-a2a registered domains (NO stub)', async () => {
      for (const domainId of ['eval:memory', 'eval:sop', 'eval:task-outcome', 'eval:capability-wakeup']) {
        const result = await handleGenerateNow(
          { harnessFeedbackRoot: root },
          {
            domainId,
            userId: 'test-user',
            verdictId: 'test',
            snapshotName: 'foo.yaml',
            attributionName: 'bar.yaml',
          },
        );
        assert.ok('error' in result, `${domainId} expected error`);
        assert.equal(result.status, 501, `${domainId} expected 501`);
        assert.equal(result.error, 'unsupported_generator', `${domainId} expected unsupported_generator`);
        assert.match(result.detail, /registered/, `${domainId} detail must confirm registered`);
      }
    });

    it('returns 400 when required body fields missing for eval:a2a', async () => {
      const result = await handleGenerateNow(
        { harnessFeedbackRoot: root },
        {
          domainId: 'eval:a2a',
          userId: 'test-user',
          snapshotName: 'foo.yaml',
          attributionName: 'bar.yaml',
        },
      );
      assert.ok('error' in result);
      assert.equal(result.status, 400);
    });

    // Cloud codex R3 P2: non-string body fields → 400 (NOT 500 from basename throw)
    it('returns 400 for non-string body field values (NOT 500 from basename throw)', async () => {
      const nonStringValues = [{ malicious: true }, 123, null, ['x'], true];
      for (const value of nonStringValues) {
        for (const field of ['verdictId', 'snapshotName', 'attributionName']) {
          const input = {
            domainId: 'eval:a2a',
            userId: 'test-user',
            verdictId: 'test',
            snapshotName: 'foo.yaml',
            attributionName: 'bar.yaml',
          };
          input[field] = value;
          const result = await handleGenerateNow({ harnessFeedbackRoot: root }, input);
          assert.ok('error' in result, `${field}=${JSON.stringify(value)} expected error`);
          assert.equal(result.status, 400, `${field}=${JSON.stringify(value)} must be 400 not 500`);
        }
      }
    });

    // Cloud codex R4 P2: slug-invalid verdictId → 400 (NOT 500 from generator throw)
    it('returns 400 for slug-invalid verdictId (NOT 500 from generator)', async () => {
      const slugViolations = ['Test-Foo', 'test_foo', '-leading', 'foo.bar', 'foo bar', 'foo/bar'];
      for (const value of slugViolations) {
        const result = await handleGenerateNow(
          { harnessFeedbackRoot: root },
          {
            domainId: 'eval:a2a',
            userId: 'test-user',
            verdictId: value,
            snapshotName: 'foo.yaml',
            attributionName: 'bar.yaml',
          },
        );
        assert.ok('error' in result, `'${value}' expected error`);
        assert.equal(result.status, 400, `'${value}' must be 400 not 500`);
        assert.match(result.error, /safe slug/i, `'${value}' error must mention safe slug`);
      }
    });

    // 砚砚 R1 P1: path traversal in snapshotName/attributionName → 400 before any readFileSync
    it('returns 400 before basename() for path-traversal in snapshotName/attributionName', async () => {
      const traversalValues = ['../etc/passwd', '/etc/passwd', 'subdir/leak.yaml', '', '..', '.'];
      for (const value of traversalValues) {
        for (const field of ['snapshotName', 'attributionName']) {
          const input = {
            domainId: 'eval:a2a',
            userId: 'test-user',
            verdictId: 'test',
            snapshotName: 'foo.yaml',
            attributionName: 'bar.yaml',
          };
          input[field] = value;
          const result = await handleGenerateNow({ harnessFeedbackRoot: root }, input);
          assert.ok('error' in result, `${field}='${value}' expected rejection`);
          assert.equal(result.status, 400, `${field}='${value}' must be 400 not 500`);
          assert.match(result.error, new RegExp(field), `${field}='${value}' error must call out ${field}`);
        }
      }
    });

    it('returns 500 when generator throws (valid basenames but missing files)', async () => {
      const result = await handleGenerateNow(
        { harnessFeedbackRoot: root },
        {
          domainId: 'eval:a2a',
          userId: 'test-user',
          verdictId: 'test-missing-files',
          snapshotName: 'nonexistent-snapshot.yaml',
          attributionName: 'nonexistent-attribution.yaml',
        },
      );
      assert.ok('error' in result);
      assert.equal(result.status, 500);
      assert.match(result.error, /Generator failed/);
    });

    // 砚砚 R0 P1: e2e roundtrip — generated verdict appears in Hub summary
    it('eval:a2a generates verdict + roundtrips through loadEvalHubSummary()', async () => {
      const { snapshotName, attributionName } = setupRawArtifacts(root, '2026-06-04');
      const verdictId = '2026-06-04-eval-a2a-roundtrip-test';

      const result = await handleGenerateNow(
        { harnessFeedbackRoot: root },
        {
          domainId: 'eval:a2a',
          userId: 'test-user',
          verdictId,
          snapshotName,
          attributionName,
        },
      );

      assert.ok(!('error' in result), `Expected success, got: ${JSON.stringify(result)}`);
      assert.equal(result.ok, true);
      assert.equal(result.domainId, 'eval:a2a');
      assert.equal(result.verdictId, verdictId);
      assert.ok(result.verdictPath.endsWith(`${verdictId}.md`));
      assert.ok(result.bundleDir.includes(verdictId));
      assert.equal(result.hubRoundtrip.ok, true, `roundtrip failed: ${JSON.stringify(result.hubRoundtrip)}`);
      assert.ok(result.hubRoundtrip.itemCount >= 1);
    });

    // Cloud codex R10 P1 + 砚砚收敛 A: idempotency — duplicate verdictId → 409, no overwrite
    it('rejects duplicate verdictId with 409 + does NOT overwrite (砚砚 R10)', async () => {
      const { snapshotName, attributionName } = setupRawArtifacts(root, '2026-06-05');
      const verdictId = '2026-06-05-eval-a2a-idempotency-test';
      const input = { domainId: 'eval:a2a', userId: 'test-user', verdictId, snapshotName, attributionName };
      const first = await handleGenerateNow({ harnessFeedbackRoot: root }, input);
      assert.ok(!('error' in first), `first should succeed: ${JSON.stringify(first)}`);
      const original = readFileSync(first.verdictPath, 'utf8');
      const second = await handleGenerateNow({ harnessFeedbackRoot: root }, input);
      assert.ok('error' in second);
      assert.equal(second.status, 409);
      assert.equal(second.error, 'verdict_already_exists');
      assert.match(second.detail, /forbidden|data integrity/i);
      assert.equal(readFileSync(first.verdictPath, 'utf8'), original, 'verdict must NOT be overwritten');
    });

    // 砚砚收敛 A: length limits — prevent DoS via huge inputs
    it('rejects oversized verdictId/snapshotName/attributionName with 400 (砚砚 R10)', async () => {
      const big = 'a'.repeat(300);
      const base = {
        domainId: 'eval:a2a',
        userId: 'test-user',
        verdictId: 'ok',
        snapshotName: 'foo.yaml',
        attributionName: 'bar.yaml',
      };
      for (const field of ['verdictId', 'snapshotName', 'attributionName']) {
        const value = field === 'verdictId' ? big : `${big}.yaml`;
        const result = await handleGenerateNow({ harnessFeedbackRoot: root }, { ...base, [field]: value });
        assert.ok('error' in result, `${field}=oversized expected rejection`);
        assert.equal(result.status, 400, `${field}=oversized must be 400`);
        assert.match(result.error, new RegExp(field), `${field} error must call out ${field}`);
      }
    });
  });
});
