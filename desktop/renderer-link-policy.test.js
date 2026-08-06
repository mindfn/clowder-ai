const assert = require('node:assert/strict');
const { describe, test } = require('node:test');
const {
  createRendererLinkOrigins,
  isAllowedRendererLink,
  resolveRendererLinkOrigins,
} = require('./renderer-link-policy');

describe('renderer popup link policy', () => {
  const appOrigin = 'http://localhost:3003';
  const apiOrigin = 'http://localhost:3004';
  const previewOrigin = 'http://localhost:4100';
  const approvedLocalOrigins = new Set([appOrigin, apiOrigin, previewOrigin]);

  test('allows HTTPS links for the system browser', () => {
    assert.equal(isAllowedRendererLink('https://example.com/releases'), true);
  });

  test('allows links on the exact app, API, and preview loopback origins', () => {
    assert.equal(
      isAllowedRendererLink(`${appOrigin}/uploads/screenshot.png`, approvedLocalOrigins),
      true,
      'same-origin links are served through the web rewrite',
    );
    assert.equal(
      isAllowedRendererLink(`${apiOrigin}/uploads/artifact.pdf`, approvedLocalOrigins),
      true,
      'explicit API-origin artifacts remain usable',
    );
    assert.equal(
      isAllowedRendererLink(`${previewOrigin}/?__preview_port=5173`, approvedLocalOrigins),
      true,
      'preview gateway popups remain usable without admitting the target dev-server port',
    );
  });

  test('derives the admitted preview origin from an exact gateway port', () => {
    const runtimeOrigins = createRendererLinkOrigins({
      appOrigin,
      apiOrigin,
      previewGatewayPort: 4317,
    });

    assert.equal(
      isAllowedRendererLink('http://localhost:4317/?__preview_port=5173', runtimeOrigins),
      true,
      'the configured preview gateway must remain usable',
    );
    assert.equal(
      isAllowedRendererLink('http://localhost:4100/?__preview_port=5173', runtimeOrigins),
      false,
      'the default gateway must not remain admitted after configuration moves it',
    );
  });

  test('derives the admitted preview origin from runtime status when port zero is configured', async () => {
    const runtimeOrigins = await resolveRendererLinkOrigins({
      appOrigin,
      apiOrigin,
      loadPreviewGatewayStatus: async () => ({ available: true, gatewayPort: 4317 }),
    });

    assert.equal(
      isAllowedRendererLink('http://localhost:4317/?__preview_port=5173', runtimeOrigins),
      true,
      'the ephemeral preview gateway origin must remain usable',
    );
    assert.equal(
      isAllowedRendererLink('http://localhost:4100/?__preview_port=5173', runtimeOrigins),
      false,
      'runtime discovery must not admit the default or arbitrary sibling ports',
    );
  });

  test('admits no preview origin when runtime status reports the gateway unavailable', async () => {
    const runtimeOrigins = await resolveRendererLinkOrigins({
      appOrigin,
      apiOrigin,
      loadPreviewGatewayStatus: async () => ({ available: false, gatewayPort: 4100 }),
    });

    assert.deepEqual(runtimeOrigins, new Set([appOrigin, apiOrigin]));
  });

  test('fails closed when the configured preview gateway port is invalid', () => {
    const configuredOrigins = createRendererLinkOrigins({
      appOrigin,
      apiOrigin,
      previewGatewayPort: Number.NaN,
    });

    assert.deepEqual(configuredOrigins, new Set([appOrigin, apiOrigin]));
  });

  test('rejects HTTP origin lookalikes and sibling loopback ports', () => {
    for (const url of [
      'http://localhost:3003@attacker.example/uploads/screenshot.png',
      'http://localhost:3003.attacker.example/uploads/screenshot.png',
      'http://localhost:3005/uploads/screenshot.png',
      'http://127.0.0.1:3003/uploads/screenshot.png',
      'http://example.com/uploads/screenshot.png',
    ]) {
      assert.equal(isAllowedRendererLink(url, approvedLocalOrigins), false, url);
    }
  });

  test('rejects non-HTTPS and malformed links', () => {
    assert.equal(isAllowedRendererLink('http://localhost:3003/uploads/screenshot.png'), false);
    assert.equal(isAllowedRendererLink('file:///Users/example/private.txt'), false);
    assert.equal(isAllowedRendererLink('not a URL'), false);
  });
});
