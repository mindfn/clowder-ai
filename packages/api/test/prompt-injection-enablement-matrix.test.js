// F257 Console 判据⑥ — Enablement matrix API contract tests.
// Verifies that manifest and content endpoints expose a single matrix
// (safetyTier × allowLocalOverride × disableable × overrideState) so the
// Console can show consistent CTA states and blocked reasons.
import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import Fastify from 'fastify';
import { promptInjectionRoutes } from '../dist/routes/prompt-injection.js';
import { promptInjectionManifestRoutes } from '../dist/routes/prompt-injection-manifest.js';

const OWNER = 'test-owner';

async function buildManifestApp(sessionUserId = OWNER) {
  const app = Fastify();
  if (sessionUserId) {
    app.addHook('onRequest', (req, _reply, done) => {
      req.sessionUserId = sessionUserId;
      done();
    });
  }
  await app.register(promptInjectionManifestRoutes);
  await app.ready();
  return app;
}

async function buildContentApp(sessionUserId = OWNER) {
  const app = Fastify();
  if (sessionUserId) {
    app.addHook('onRequest', (req, _reply, done) => {
      req.sessionUserId = sessionUserId;
      done();
    });
  }
  await app.register(promptInjectionRoutes);
  await app.ready();
  return app;
}

describe('prompt-injection enablement matrix (判据⑥)', () => {
  before(() => {
    process.env.DEFAULT_OWNER_USER_ID = OWNER;
  });

  it('manifest exposes enablementMatrix for every segment', async () => {
    const app = await buildManifestApp();
    const res = await app.inject({ method: 'GET', url: '/api/prompt-injection/manifest' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.ok(Array.isArray(body.segments));
    assert.ok(body.segments.length > 0);
    for (const segment of body.segments) {
      assert.ok(segment.enablementMatrix, `segment ${segment.id} missing enablementMatrix`);
      const m = segment.enablementMatrix;
      assert.equal(m.segmentId, segment.id);
      assert.equal(m.safetyTier, segment.safetyTier);
      assert.equal(m.allowLocalOverride, segment.allowLocalOverride);
      assert.equal(m.disableable, segment.disableable);
      assert.ok(m.overrideState);
      assert.ok(m.actions);
      for (const action of ['edit', 'disable', 'enable', 'rollback', 'restoreBackup', 'activateVersion']) {
        assert.ok(Object.hasOwn(m.actions, action), `segment ${segment.id} missing action ${action}`);
        const perm = m.actions[action];
        assert.ok(Object.hasOwn(perm, 'allowed'));
        assert.ok(Object.hasOwn(perm, 'reason'));
        assert.ok(Object.hasOwn(perm, 'reasonCode'));
        if (perm.allowed) {
          assert.equal(perm.reason, null);
          assert.equal(perm.reasonCode, null);
        } else {
          assert.ok(perm.reason, `segment ${segment.id} action ${action} blocked without reason`);
          assert.ok(perm.reasonCode, `segment ${segment.id} action ${action} blocked without reasonCode`);
        }
      }
    }
    await app.close();
  });

  it('readonly + no-overlay segment blocks edit with safety-tier reason', async () => {
    const app = await buildManifestApp();
    const res = await app.inject({ method: 'GET', url: '/api/prompt-injection/manifest' });
    const { segments } = res.json();
    const s1 = segments.find((s) => s.id === 'S1');
    assert.ok(s1);
    assert.equal(s1.safetyTier, 'readonly');
    assert.equal(s1.allowLocalOverride, false);
    const edit = s1.enablementMatrix.actions.edit;
    assert.equal(edit.allowed, false);
    assert.equal(edit.reasonCode, 'safety-tier-readonly');
    const disable = s1.enablementMatrix.actions.disable;
    assert.equal(disable.allowed, false);
    assert.equal(disable.reasonCode, 'not-disableable');
    await app.close();
  });

  it('editable + overlay + disableable segment allows edit and disable', async () => {
    const app = await buildManifestApp();
    const res = await app.inject({ method: 'GET', url: '/api/prompt-injection/manifest' });
    const { segments } = res.json();
    const d10 = segments.find((s) => s.id === 'D10');
    assert.ok(d10);
    assert.equal(d10.safetyTier, 'readonly');
    assert.equal(d10.allowLocalOverride, false);
    assert.equal(d10.disableable, true);
    // D10 is readonly in manifest, so edit is blocked; disable is allowed.
    assert.equal(d10.enablementMatrix.actions.edit.allowed, false);
    assert.equal(d10.enablementMatrix.actions.disable.allowed, true);
    await app.close();
  });

  it('content endpoint exposes enablementMatrix', async () => {
    const app = await buildContentApp();
    const res = await app.inject({ method: 'GET', url: '/api/prompt-injection/segment/S6/content' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.ok(body.enablementMatrix);
    assert.equal(body.enablementMatrix.segmentId, 'S6');
    assert.ok(body.enablementMatrix.actions.edit);
    await app.close();
  });

  it('401 when unauthenticated', async () => {
    const app = await buildManifestApp(null);
    const res = await app.inject({ method: 'GET', url: '/api/prompt-injection/manifest' });
    assert.equal(res.statusCode, 401);
    await app.close();
  });
});
