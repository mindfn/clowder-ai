// F257 Console 判据⑥ — Enablement matrix API contract tests.
// Verifies that manifest and content endpoints expose a two-plane matrix
// (localOverlay × runtimeOverride) derived from safetyTier, allowLocalOverride,
// disableable and actual storage state, so the Console shows consistent CTA
// states and blocked reasons.
import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import Fastify from 'fastify';
import { TEMPLATE_FILES } from '../dist/domains/cats/services/context/prompt-template-loader.js';
import { promptInjectionRoutes } from '../dist/routes/prompt-injection.js';
import { promptInjectionManifestRoutes } from '../dist/routes/prompt-injection-manifest.js';

const OWNER = 'test-owner';
const LOCAL_WRITE_HEADERS = {
  host: '127.0.0.1:3004',
  origin: 'http://127.0.0.1:3003',
};

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

      // Two-plane contract
      assert.ok(m.localOverlay, `segment ${segment.id} missing localOverlay`);
      assert.ok(m.runtimeOverride, `segment ${segment.id} missing runtimeOverride`);
      assert.ok(m.localOverlay.actions);
      assert.ok(m.runtimeOverride.actions);

      for (const action of ['edit', 'restoreBackup', 'reset']) {
        assert.ok(
          Object.hasOwn(m.localOverlay.actions, action),
          `segment ${segment.id} missing local action ${action}`,
        );
        const perm = m.localOverlay.actions[action];
        assert.ok(Object.hasOwn(perm, 'allowed'));
        assert.ok(Object.hasOwn(perm, 'reason'));
        assert.ok(Object.hasOwn(perm, 'reasonCode'));
        if (perm.allowed) {
          assert.equal(perm.reason, null);
          assert.equal(perm.reasonCode, null);
        } else {
          assert.ok(perm.reason, `segment ${segment.id} local action ${action} blocked without reason`);
          assert.ok(perm.reasonCode, `segment ${segment.id} local action ${action} blocked without reasonCode`);
        }
      }

      for (const action of ['disable', 'enable', 'rollback', 'activateVersion']) {
        assert.ok(
          Object.hasOwn(m.runtimeOverride.actions, action),
          `segment ${segment.id} missing runtime action ${action}`,
        );
        const perm = m.runtimeOverride.actions[action];
        assert.ok(Object.hasOwn(perm, 'allowed'));
        assert.ok(Object.hasOwn(perm, 'reason'));
        assert.ok(Object.hasOwn(perm, 'reasonCode'));
        if (perm.allowed) {
          assert.equal(perm.reason, null);
          assert.equal(perm.reasonCode, null);
        } else {
          assert.ok(perm.reason, `segment ${segment.id} runtime action ${action} blocked without reason`);
          assert.ok(perm.reasonCode, `segment ${segment.id} runtime action ${action} blocked without reasonCode`);
        }
      }
    }
    await app.close();
  });

  it('readonly + no-overlay segment blocks local edit with safety-tier reason', async () => {
    const app = await buildManifestApp();
    const res = await app.inject({ method: 'GET', url: '/api/prompt-injection/manifest' });
    const { segments } = res.json();
    const s1 = segments.find((s) => s.id === 'S1');
    assert.ok(s1);
    assert.equal(s1.safetyTier, 'readonly');
    assert.equal(s1.allowLocalOverride, false);
    const edit = s1.enablementMatrix.localOverlay.actions.edit;
    assert.equal(edit.allowed, false);
    assert.equal(edit.reasonCode, 'safety-tier-readonly');
    const disable = s1.enablementMatrix.runtimeOverride.actions.disable;
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
    assert.equal(d10.enablementMatrix.localOverlay.actions.edit.allowed, false);
    assert.equal(d10.enablementMatrix.runtimeOverride.actions.disable.allowed, true);
    await app.close();
  });

  it('content endpoint exposes enablementMatrix', async () => {
    const app = await buildContentApp();
    const res = await app.inject({ method: 'GET', url: '/api/prompt-injection/segment/S6/content' });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.ok(body.enablementMatrix);
    assert.equal(body.enablementMatrix.segmentId, 'S6');
    assert.ok(body.enablementMatrix.localOverlay.actions.edit);
    assert.ok(body.enablementMatrix.runtimeOverride.actions.disable);
    await app.close();
  });

  it('content endpoint uses hook manifest safetyTier (C1 editable, D1 readonly)', async () => {
    const app = await buildContentApp();
    const c1 = await app.inject({ method: 'GET', url: '/api/prompt-injection/segment/C1/content' });
    assert.equal(c1.statusCode, 200);
    const c1Body = c1.json();
    assert.equal(c1Body.enablementMatrix.safetyTier, 'editable');
    assert.equal(c1Body.enablementMatrix.localOverlay.actions.edit.allowed, true);

    const d1 = await app.inject({ method: 'GET', url: '/api/prompt-injection/segment/D1/content' });
    assert.equal(d1.statusCode, 200);
    const d1Body = d1.json();
    assert.equal(d1Body.enablementMatrix.safetyTier, 'readonly');
    assert.equal(d1Body.enablementMatrix.localOverlay.actions.edit.allowed, false);
    assert.equal(d1Body.enablementMatrix.localOverlay.actions.edit.reasonCode, 'safety-tier-readonly');
    await app.close();
  });

  it('PUT /override rejects readonly segment on server side', async () => {
    const app = await buildContentApp(OWNER);
    const res = await app.inject({
      method: 'PUT',
      url: '/api/prompt-injection/segment/D1/override',
      headers: { ...LOCAL_WRITE_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'edited' }),
    });
    assert.equal(res.statusCode, 403);
    const body = res.json();
    assert.match(body.error, /readonly/i);
    await app.close();
  });

  it('POST /restore-backup rejects readonly segment on server side', async () => {
    const app = await buildContentApp(OWNER);
    const res = await app.inject({
      method: 'POST',
      url: '/api/prompt-injection/segment/D1/restore-backup',
      headers: LOCAL_WRITE_HEADERS,
    });
    assert.equal(res.statusCode, 403);
    const body = res.json();
    assert.match(body.error, /readonly/i);
    await app.close();
  });

  it('PUT /override rejects safetyTier=readonly even when local overlay path exists', async () => {
    const originalD1 = TEMPLATE_FILES.D1;
    // D1 is readonly and normally has no local overlay path. Give it one so the
    // only remaining blocker is the safetyTier gate.
    TEMPLATE_FILES.D1 = { ...originalD1, local: 'd1-identity-anchor.local.md' };
    try {
      const app = await buildContentApp(OWNER);
      const res = await app.inject({
        method: 'PUT',
        url: '/api/prompt-injection/segment/D1/override',
        headers: { ...LOCAL_WRITE_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'edited' }),
      });
      assert.equal(res.statusCode, 403);
      const body = res.json();
      assert.match(body.error, /readonly/i);
      await app.close();
    } finally {
      TEMPLATE_FILES.D1 = originalD1;
    }
  });

  it('POST /restore-backup rejects safetyTier=readonly even when local overlay path exists', async () => {
    const originalD1 = TEMPLATE_FILES.D1;
    TEMPLATE_FILES.D1 = { ...originalD1, local: 'd1-identity-anchor.local.md' };
    try {
      const app = await buildContentApp(OWNER);
      const res = await app.inject({
        method: 'POST',
        url: '/api/prompt-injection/segment/D1/restore-backup',
        headers: LOCAL_WRITE_HEADERS,
      });
      assert.equal(res.statusCode, 403);
      const body = res.json();
      assert.match(body.error, /readonly/i);
      await app.close();
    } finally {
      TEMPLATE_FILES.D1 = originalD1;
    }
  });

  it('401 when unauthenticated', async () => {
    const app = await buildManifestApp(null);
    const res = await app.inject({ method: 'GET', url: '/api/prompt-injection/manifest' });
    assert.equal(res.statusCode, 401);
    await app.close();
  });
});
