import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it, mock } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createEvalDomainDailySpec } from '../../dist/infrastructure/harness-eval/domain/eval-domain-daily.js';
import {
  buildEvidencePrereqSkippedMessage,
  createTelemetryEvidencePrereqProbe,
  evaluateEvidencePrereq,
} from '../../dist/infrastructure/harness-eval/domain/eval-domain-evidence-gate.js';
import { createEvalDomainNDaySpec } from '../../dist/infrastructure/harness-eval/domain/eval-domain-nday.js';
import { FIXTURE_FRICTION_3D_YAML, makeTempRoot } from './eval-domain-nday-fixtures.js';

const repoHarnessFeedbackRoot = fileURLToPath(new URL('../../../../docs/harness-feedback', import.meta.url));

/**
 * Evidence-source prereq gate (eval:a2a build verdict
 * `2026-07-07-eval-a2a-reeval-telemetry-still-disabled-build`, PR #19).
 *
 * Bug class: the scheduled eval fires on a runtime whose OTel telemetry is
 * disabled (TELEMETRY_HMAC_SALT unset → initTelemetry() returned null handles).
 * The `f167-runtime-eval` source cannot produce fresh snapshots, yet the eval
 * cat is invoked anyway and burns a full LLM session to re-conclude "telemetry
 * still disabled" — every day (2026-06-30 → 2026-07-07 verdict series). The
 * gate fails closed BEFORE invocation and posts a zero-LLM-cost skip notice
 * to the domain's own system thread instead.
 */
describe('eval-domain evidence-source prereq gate (fork-only; mindfn PR #91/#137)', () => {
  /**
   * RFC 5.4: the eval cat is woken through the DELIVER seam - the envelope carries
   * `targetCatId` + `privateContent`. The old positional `invokeTrigger.trigger()`
   * call is dead, so asserting `triggerMock.callCount() === 0` proves NOTHING about
   * whether the cat was invoked (it is trivially 0 on every path).
   *
   * `catWakes()` counts real wakes on the live seam, so "cat never invoked" is a
   * claim this suite can actually falsify.
   */
  const mkCtx = () => {
    const deliverMock = mock.fn(async () => 'msg_evidence');
    const triggerMock = mock.fn();
    const catWakes = () =>
      deliverMock.mock.calls
        .map((c) => c.arguments[0])
        .filter((env) => env?.targetCatId != null || env?.privateContent != null);
    return {
      deliverMock,
      triggerMock,
      catWakes,
      ctx: { assignedCatId: null, deliver: deliverMock, invokeTrigger: { trigger: triggerMock } },
    };
  };

  describe('createTelemetryEvidencePrereqProbe', () => {
    it('telemetry-backed adapter + OTel disabled → not ok, reason points at salt', () => {
      const probe = createTelemetryEvidencePrereqProbe({ otelEnabled: () => false });
      const result = probe({ domainId: 'eval:a2a', sourceAdapter: 'f167-runtime-eval' });
      assert.equal(result.ok, false);
      assert.ok(
        result.reason.includes('TELEMETRY_HMAC_SALT'),
        `default reason must name the missing salt env var (got: ${result.reason})`,
      );
    });

    it('telemetry-backed adapter + OTel enabled → ok', () => {
      const probe = createTelemetryEvidencePrereqProbe({ otelEnabled: () => true });
      const result = probe({ domainId: 'eval:a2a', sourceAdapter: 'f167-runtime-eval' });
      assert.equal(result.ok, true);
    });

    it('non-telemetry adapter passes through even when OTel is disabled', () => {
      const probe = createTelemetryEvidencePrereqProbe({ otelEnabled: () => false });
      const result = probe({ domainId: 'eval:sop', sourceAdapter: 'sop-trace-eval' });
      assert.equal(result.ok, true, 'gate must only constrain telemetry-backed source adapters');
    });

    it('OTEL_SDK_DISABLED=true → reason names the env toggle, not the salt', () => {
      const prev = process.env.OTEL_SDK_DISABLED;
      process.env.OTEL_SDK_DISABLED = 'true';
      try {
        const probe = createTelemetryEvidencePrereqProbe({ otelEnabled: () => false });
        const result = probe({ domainId: 'eval:a2a', sourceAdapter: 'f167-runtime-eval' });
        assert.equal(result.ok, false);
        assert.ok(result.reason.includes('OTEL_SDK_DISABLED'), `got: ${result.reason}`);
      } finally {
        if (prev === undefined) delete process.env.OTEL_SDK_DISABLED;
        else process.env.OTEL_SDK_DISABLED = prev;
      }
    });
  });

  /**
   * Upstream review finding (zts212653/clowder-ai#1352): `otelEnabled` observes the
   * CRON process's telemetry handle, but evidence is fetched from the adapter target
   * (EVAL_BASE_URL). When those differ the local handle proves nothing about the
   * remote source, in BOTH directions. The gate must fail closed rather than let a
   * local handle speak for a remote target.
   */
  describe('evidence target co-location assertion', () => {
    it('remote evidence target -> fail closed even when local OTel is healthy', () => {
      const probe = createTelemetryEvidencePrereqProbe({
        otelEnabled: () => true,
        evidenceTargetIsLocal: () => false,
      });
      const result = probe({ domainId: 'eval:a2a', sourceAdapter: 'f167-runtime-eval' });
      assert.equal(result.ok, false, 'a healthy LOCAL handle must not admit an unproven REMOTE source');
      assert.ok(result.reason.includes('remote runtime'), `got: ${result.reason}`);
    });

    it('co-located evidence target + healthy OTel -> ok', () => {
      const probe = createTelemetryEvidencePrereqProbe({
        otelEnabled: () => true,
        evidenceTargetIsLocal: () => true,
      });
      assert.equal(probe({ domainId: 'eval:a2a', sourceAdapter: 'f167-runtime-eval' }).ok, true);
    });

    it('omitted assertion stays backward-compatible (assumes co-located)', () => {
      const probe = createTelemetryEvidencePrereqProbe({ otelEnabled: () => true });
      assert.equal(probe({ domainId: 'eval:a2a', sourceAdapter: 'f167-runtime-eval' }).ok, true);
    });

    it('co-location is checked before the telemetry handle, not after', () => {
      const probe = createTelemetryEvidencePrereqProbe({
        otelEnabled: () => false,
        evidenceTargetIsLocal: () => false,
      });
      const result = probe({ domainId: 'eval:a2a', sourceAdapter: 'f167-runtime-eval' });
      assert.ok(
        result.reason.includes('remote runtime'),
        `remote-target cause must win over the local salt cause (got: ${result.reason})`,
      );
    });
  });

  /**
   * Upstream review finding (zts212653/clowder-ai#1352): the notice recommended
   * configuring TELEMETRY_HMAC_SALT even when the cause was an intentional
   * OTEL_SDK_DISABLED=true - sending the operator down the wrong path.
   */
  describe('skip notice next-action matches the detected cause', () => {
    const domain = { domainId: 'eval:a2a', sourceAdapter: 'f167-runtime-eval' };

    it('OTEL_SDK_DISABLED cause -> advises the toggle, NOT the salt', () => {
      const msg = buildEvidencePrereqSkippedMessage(domain, 'OTel disabled by OTEL_SDK_DISABLED=true');
      assert.ok(msg.includes('OTEL_SDK_DISABLED'), 'must name the actual toggle');
      assert.ok(
        !msg.includes('configure a non-empty `TELEMETRY_HMAC_SALT`'),
        'must NOT tell the operator to set a salt when the cause is a deliberate toggle',
      );
    });

    it('HMAC salt cause -> advises configuring the salt', () => {
      const msg = buildEvidencePrereqSkippedMessage(
        domain,
        'OTel disabled at boot: HMAC salt validation failed (TELEMETRY_HMAC_SALT not configured)',
      );
      assert.ok(msg.includes('configure a non-empty `TELEMETRY_HMAC_SALT`'));
    });

    it('unrecognized cause -> generic advice, no misleading specifics', () => {
      const msg = buildEvidencePrereqSkippedMessage(domain, 'evidence prereq probe threw: boom');
      assert.ok(msg.includes('resolve the blocker quoted above'));
      assert.ok(!msg.includes('TELEMETRY_HMAC_SALT'), 'must not invent a salt diagnosis');
      assert.ok(!msg.includes('OTEL_SDK_DISABLED'), 'must not invent a toggle diagnosis');
    });

    it('every cause keeps the stable grep header and quotes the reason', () => {
      for (const reason of ['OTel disabled by OTEL_SDK_DISABLED=true', 'HMAC salt validation failed', 'boom']) {
        const msg = buildEvidencePrereqSkippedMessage(domain, reason);
        assert.ok(msg.includes('SKIPPED (evidence source unavailable)'), 'stable header for grep/dedup');
        assert.ok(msg.includes(`> ${reason}`), 'reason must be quoted verbatim');
      }
    });
  });

  it('bootstrap wires the telemetry init state into every scheduled eval spec', () => {
    const indexSource = readFileSync(new URL('../../src/index.ts', import.meta.url), 'utf8');

    assert.match(indexSource, /createTelemetryEvidencePrereqProbe/);
    assert.match(
      indexSource,
      /otelEnabled:\s*\(\)\s*=>\s*telemetryHandle\.getMetricsText\s*!==\s*null/,
      'the probe must observe the actual boot-time telemetry handle, not an env proxy',
    );
    assert.match(
      indexSource,
      /const evalScheduleOpts = \{[\s\S]*?evidencePrereqProbe,[\s\S]*?\};/,
      'shared daily, weekly, and N-day schedule options must include the evidence probe',
    );
  });

  describe('evaluateEvidencePrereq', () => {
    it('probe throw → fail-closed not-ok with reason', async () => {
      const result = await evaluateEvidencePrereq(
        () => {
          throw new Error('synthetic evidence probe failure');
        },
        { domainId: 'eval:a2a', sourceAdapter: 'f167-runtime-eval' },
      );
      assert.equal(result.ok, false);
      assert.ok(result.reason.includes('synthetic evidence probe failure'));
    });
  });

  describe('daily spec integration', () => {
    async function getA2aItem(spec) {
      const gateResult = await spec.admission.gate();
      const item = gateResult.workItems.find((w) => w.subjectKey === 'eval:a2a');
      assert.ok(item, 'eval:a2a must be a registered daily domain');
      return item;
    }

    it('probe not-ok → SKIPPED notice in domain thread, cat never invoked', async () => {
      const spec = createEvalDomainDailySpec({
        harnessFeedbackRoot: repoHarnessFeedbackRoot,
        defaultUserId: 'default-user',
        evidencePrereqProbe: () => ({ ok: false, reason: 'OTel disabled at boot: HMAC salt validation failed' }),
      });
      const item = await getA2aItem(spec);
      const { deliverMock, catWakes, ctx } = mkCtx();

      await spec.run.execute(item.signal, item.subjectKey, ctx);

      assert.equal(catWakes().length, 0, 'eval cat must NOT be woken when evidence source is down');
      assert.equal(deliverMock.mock.callCount(), 1);
      const call = deliverMock.mock.calls[0].arguments[0];
      assert.equal(call.threadId, 'thread_eval_a2a', 'skip notice must stay in the domain system thread');
      assert.equal(call.userId, 'scheduler');
      assert.ok(call.content.includes('SKIPPED (evidence source unavailable)'), 'stable header for grep/dedup');
      assert.ok(call.content.includes('HMAC salt validation failed'), 'notice must carry the probe reason');
      assert.ok(call.content.includes('TELEMETRY_HMAC_SALT'), 'notice must state the actionable next step');
    });

    it('probe ok → normal invocation proceeds', async () => {
      const spec = createEvalDomainDailySpec({
        harnessFeedbackRoot: repoHarnessFeedbackRoot,
        defaultUserId: 'default-user',
        evidencePrereqProbe: () => ({ ok: true }),
      });
      const item = await getA2aItem(spec);
      const { deliverMock, catWakes, ctx } = mkCtx();

      await spec.run.execute(item.signal, item.subjectKey, ctx);

      assert.equal(catWakes().length, 1, 'eval cat is woken when evidence source is healthy');
      assert.equal(deliverMock.mock.callCount(), 1);
      assert.ok(!deliverMock.mock.calls[0].arguments[0].content.includes('SKIPPED'));
    });

    it('probe throws → fail-closed skip, no crash, no LLM call', async () => {
      const spec = createEvalDomainDailySpec({
        harnessFeedbackRoot: repoHarnessFeedbackRoot,
        defaultUserId: 'default-user',
        evidencePrereqProbe: () => {
          throw new Error('synthetic gate crash');
        },
      });
      const item = await getA2aItem(spec);
      const { deliverMock, catWakes, ctx } = mkCtx();

      await spec.run.execute(item.signal, item.subjectKey, ctx);

      assert.equal(catWakes().length, 0, 'a throwing probe must fail closed without waking the cat');
      assert.equal(deliverMock.mock.callCount(), 1);
      assert.ok(deliverMock.mock.calls[0].arguments[0].content.includes('SKIPPED (evidence source unavailable)'));
    });

    it('both gates failing → evidence-source message wins (upstream-first ordering)', async () => {
      const spec = createEvalDomainDailySpec({
        harnessFeedbackRoot: repoHarnessFeedbackRoot,
        defaultUserId: 'default-user',
        evidencePrereqProbe: () => ({ ok: false, reason: 'OTel disabled at boot' }),
        publishPrereqProbe: () => false,
      });
      const item = await getA2aItem(spec);
      const { deliverMock, catWakes, ctx } = mkCtx();

      await spec.run.execute(item.signal, item.subjectKey, ctx);

      assert.equal(catWakes().length, 0);
      assert.equal(deliverMock.mock.callCount(), 1, 'exactly one skip notice, not two');
      const content = deliverMock.mock.calls[0].arguments[0].content;
      assert.ok(content.includes('evidence source unavailable'), 'evidence gate runs before publish gate');
      assert.ok(!content.includes('publish prereq missing'));
    });

    it('evidence probe ok + publish gate still enforced → publish skip preserved', async () => {
      const spec = createEvalDomainDailySpec({
        harnessFeedbackRoot: repoHarnessFeedbackRoot,
        defaultUserId: 'default-user',
        evidencePrereqProbe: () => ({ ok: true }),
        publishPrereqProbe: () => false,
      });
      const item = await getA2aItem(spec);
      const { deliverMock, catWakes, ctx } = mkCtx();

      await spec.run.execute(item.signal, item.subjectKey, ctx);

      assert.equal(catWakes().length, 0);
      assert.equal(deliverMock.mock.callCount(), 1);
      assert.ok(deliverMock.mock.calls[0].arguments[0].content.includes('publish prereq missing'));
    });
  });

  describe('nday spec integration', () => {
    it('probe not-ok → skip notice, no trigger, no Redis last-dispatch write', async () => {
      const redisSet = mock.fn(async () => 'OK');
      const redis = { get: mock.fn(async () => null), set: redisSet };
      const harnessFeedbackRoot = makeTempRoot(FIXTURE_FRICTION_3D_YAML);
      const spec = createEvalDomainNDaySpec({
        harnessFeedbackRoot,
        defaultUserId: 'default-user',
        redis,
        evidencePrereqProbe: () => ({ ok: false, reason: 'OTel disabled at boot' }),
      });

      const gateResult = await spec.admission.gate();
      assert.equal(gateResult.run, true, 'registry must contain at least one N-day domain');
      const item = gateResult.workItems[0];
      const { deliverMock, catWakes, ctx } = mkCtx();

      await spec.run.execute(item.signal, item.subjectKey, ctx);

      assert.equal(catWakes().length, 0, 'eval cat must NOT be woken when evidence source is down');
      assert.equal(deliverMock.mock.callCount(), 1);
      const call = deliverMock.mock.calls[0].arguments[0];
      assert.equal(call.threadId, item.signal.systemThreadId);
      assert.ok(call.content.includes('SKIPPED (evidence source unavailable)'));
      assert.equal(
        redisSet.mock.callCount(),
        0,
        'skip must NOT consume the N-day window — domain retries on next daily probe',
      );
    });
  });
});
