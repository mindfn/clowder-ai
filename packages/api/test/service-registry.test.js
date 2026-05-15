import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getKnownServices, getServiceById, resolveHealthUrl } from '../dist/domains/services/service-registry.js';

describe('service-registry', () => {
  it('returns all known services', () => {
    const services = getKnownServices();
    assert.ok(services.length >= 4);
    const ids = services.map((s) => s.id);
    assert.ok(ids.includes('whisper-stt'));
    assert.ok(ids.includes('mlx-tts'));
    assert.ok(ids.includes('embedding-model'));
    assert.ok(ids.includes('llm-postprocess'));
  });

  it('finds a service by id', () => {
    const svc = getServiceById('whisper-stt');
    assert.ok(svc);
    assert.equal(svc.port, 9876);
    assert.equal(svc.type, 'python');
    assert.ok(svc.enablesFeatures.includes('voice-input'));
  });

  it('returns undefined for unknown id', () => {
    assert.equal(getServiceById('nonexistent'), undefined);
  });

  it('each service has required manifest fields', () => {
    for (const svc of getKnownServices()) {
      assert.ok(svc.id);
      assert.ok(svc.name);
      assert.ok(['python', 'node', 'binary'].includes(svc.type));
      assert.ok(Array.isArray(svc.enablesFeatures));
      assert.ok(Array.isArray(svc.configVars));
    }
  });

  it('python services have health endpoints and ports', () => {
    const pythonServices = getKnownServices().filter((s) => s.type === 'python');
    assert.ok(pythonServices.length > 0);
    for (const svc of pythonServices) {
      assert.ok(svc.port > 0);
      assert.equal(svc.healthEndpoint, '/health');
    }
  });
});

describe('resolveHealthUrl', () => {
  it('uses port-only env var to construct health URL', () => {
    const saved = process.env.EMBED_PORT;
    const savedUrl = process.env.EMBED_URL;
    delete process.env.EMBED_URL;
    process.env.EMBED_PORT = '9999';
    try {
      const manifest = getServiceById('embedding-model');
      const url = resolveHealthUrl(manifest);
      assert.equal(url, 'http://127.0.0.1:9999/health');
    } finally {
      if (savedUrl !== undefined) process.env.EMBED_URL = savedUrl;
      else delete process.env.EMBED_URL;
      if (saved !== undefined) process.env.EMBED_PORT = saved;
      else delete process.env.EMBED_PORT;
    }
  });

  it('prefers URL env var over port env var', () => {
    const savedUrl = process.env.EMBED_URL;
    const savedPort = process.env.EMBED_PORT;
    process.env.EMBED_URL = 'http://custom-host:8080';
    process.env.EMBED_PORT = '9999';
    try {
      const manifest = getServiceById('embedding-model');
      const url = resolveHealthUrl(manifest);
      assert.equal(url, 'http://custom-host:8080/health');
    } finally {
      if (savedUrl !== undefined) process.env.EMBED_URL = savedUrl;
      else delete process.env.EMBED_URL;
      if (savedPort !== undefined) process.env.EMBED_PORT = savedPort;
      else delete process.env.EMBED_PORT;
    }
  });

  it('falls back to manifest default port when no env vars set', () => {
    const savedUrl = process.env.EMBED_URL;
    const savedPort = process.env.EMBED_PORT;
    delete process.env.EMBED_URL;
    delete process.env.EMBED_PORT;
    try {
      const manifest = getServiceById('embedding-model');
      const url = resolveHealthUrl(manifest);
      assert.equal(url, 'http://127.0.0.1:9880/health');
    } finally {
      if (savedUrl !== undefined) process.env.EMBED_URL = savedUrl;
      if (savedPort !== undefined) process.env.EMBED_PORT = savedPort;
    }
  });

  it('rejects partial-parse strings like host:port (codex P2 3249279172)', () => {
    // `Number.parseInt('127.0.0.1:9880')` returns 127 — a malformed env value
    // must NOT cause the resolver to silently spawn on port 127. Strict parser
    // requires the entire string to be a positive integer in the port range.
    const savedUrl = process.env.EMBED_URL;
    const savedPort = process.env.EMBED_PORT;
    delete process.env.EMBED_URL;
    process.env.EMBED_PORT = '127.0.0.1:9880'; // looks like host:port, NOT a port
    try {
      const manifest = getServiceById('embedding-model');
      const url = resolveHealthUrl(manifest);
      // Should fall through to manifest default (9880), NOT parse 127.
      assert.equal(url, 'http://127.0.0.1:9880/health');
    } finally {
      if (savedUrl !== undefined) process.env.EMBED_URL = savedUrl;
      else delete process.env.EMBED_URL;
      if (savedPort !== undefined) process.env.EMBED_PORT = savedPort;
      else delete process.env.EMBED_PORT;
    }
  });

  it('rejects trailing-junk strings like 9880/foo (codex P2 3249279172)', () => {
    const savedUrl = process.env.EMBED_URL;
    const savedPort = process.env.EMBED_PORT;
    delete process.env.EMBED_URL;
    process.env.EMBED_PORT = '9880/foo';
    try {
      const manifest = getServiceById('embedding-model');
      const url = resolveHealthUrl(manifest);
      assert.equal(url, 'http://127.0.0.1:9880/health'); // manifest default, not parsed
    } finally {
      if (savedUrl !== undefined) process.env.EMBED_URL = savedUrl;
      else delete process.env.EMBED_URL;
      if (savedPort !== undefined) process.env.EMBED_PORT = savedPort;
      else delete process.env.EMBED_PORT;
    }
  });

  it('rejects out-of-range port values', () => {
    const savedUrl = process.env.EMBED_URL;
    const savedPort = process.env.EMBED_PORT;
    delete process.env.EMBED_URL;
    process.env.EMBED_PORT = '99999'; // > 65535
    try {
      const manifest = getServiceById('embedding-model');
      const url = resolveHealthUrl(manifest);
      assert.equal(url, 'http://127.0.0.1:9880/health'); // manifest default
    } finally {
      if (savedUrl !== undefined) process.env.EMBED_URL = savedUrl;
      else delete process.env.EMBED_URL;
      if (savedPort !== undefined) process.env.EMBED_PORT = savedPort;
      else delete process.env.EMBED_PORT;
    }
  });
});
