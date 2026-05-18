/**
 * Protocol engine unit tests — template rendering, JSONPath, auth, YAML loading
 */

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  extractJsonPath,
  extractString,
  getAuthStrategy,
  loadProtocolsFromDir,
  loadProtocolTemplate,
  ProtocolTemplateSchema,
  renderBody,
  renderTemplate,
} from '../dist/protocol-engine/index.js';

// ── Template rendering ──

describe('renderTemplate', () => {
  it('substitutes simple variables', () => {
    assert.equal(renderTemplate('Hello {{name}}!', { name: 'World' }), 'Hello World!');
  });

  it('applies default filter for missing variable', () => {
    assert.equal(renderTemplate('model={{model | default:cogvideox-flash}}', {}), 'model=cogvideox-flash');
  });

  it('uses actual value over default when present', () => {
    assert.equal(renderTemplate('model={{model | default:cogvideox-flash}}', { model: 'kling-v2' }), 'model=kling-v2');
  });

  it('applies base64 filter', () => {
    const result = renderTemplate('data={{content | base64}}', { content: 'hello' });
    assert.equal(result, `data=${Buffer.from('hello').toString('base64')}`);
  });

  it('replaces missing variable with empty string', () => {
    assert.equal(renderTemplate('key={{missing}}', {}), 'key=');
  });

  it('handles multiple variables in one string', () => {
    assert.equal(renderTemplate('{{a}}/{{b}}/{{c}}', { a: 'x', b: 'y', c: 'z' }), 'x/y/z');
  });
});

describe('renderBody', () => {
  it('recursively renders object values', () => {
    const body = { model: '{{model}}', prompt: '{{prompt}}' };
    const result = renderBody(body, { model: 'test', prompt: 'hello' });
    assert.deepEqual(result, { model: 'test', prompt: 'hello' });
  });

  it('renders arrays', () => {
    const body = ['{{a}}', '{{b}}'];
    assert.deepEqual(renderBody(body, { a: '1', b: '2' }), ['1', '2']);
  });

  it('handles nested objects', () => {
    const body = { outer: { inner: '{{val}}' } };
    assert.deepEqual(renderBody(body, { val: 'deep' }), { outer: { inner: 'deep' } });
  });

  it('passes through non-string primitives', () => {
    assert.equal(renderBody(42, {}), 42);
    assert.equal(renderBody(null, {}), null);
    assert.equal(renderBody(true, {}), true);
  });
});

// ── JSONPath extraction ──

describe('extractJsonPath', () => {
  const data = {
    id: 'task-123',
    data: {
      task_id: 'abc',
      task_status: 'succeed',
      task_result: {
        videos: [{ url: 'https://cdn.example.com/v.mp4', duration: '5s' }],
      },
    },
    candidates: [{ content: { parts: [{ text: 'analysis result' }] } }],
    video_result: [{ url: 'https://cdn.example.com/cog.mp4', cover_image_url: 'https://cdn.example.com/cover.jpg' }],
  };

  it('extracts top-level field', () => {
    assert.equal(extractJsonPath(data, '$.id'), 'task-123');
  });

  it('extracts nested field', () => {
    assert.equal(extractJsonPath(data, '$.data.task_id'), 'abc');
  });

  it('extracts deeply nested field', () => {
    assert.equal(extractJsonPath(data, '$.data.task_result.videos[0].url'), 'https://cdn.example.com/v.mp4');
  });

  it('extracts Gemini-style response', () => {
    assert.equal(extractJsonPath(data, '$.candidates[0].content.parts[0].text'), 'analysis result');
  });

  it('extracts CogVideoX-style response', () => {
    assert.equal(extractJsonPath(data, '$.video_result[0].url'), 'https://cdn.example.com/cog.mp4');
  });

  it('returns undefined for missing path', () => {
    assert.equal(extractJsonPath(data, '$.nonexistent.field'), undefined);
  });

  it('returns undefined for invalid root', () => {
    assert.equal(extractJsonPath(null, '$.foo'), undefined);
  });
});

describe('extractString', () => {
  it('converts number to string', () => {
    assert.equal(extractString({ code: 10000 }, '$.code'), '10000');
  });
});

// ── Auth strategies ──

describe('auth strategies', () => {
  it('apikey produces Bearer header', () => {
    const strategy = getAuthStrategy('apikey');
    const result = strategy.sign({ apiKey: 'sk-test' }, { method: 'POST', url: 'https://api.example.com' });
    assert.equal(result.headers?.['Authorization'], 'Bearer sk-test');
  });

  it('query-param produces query params', () => {
    const strategy = getAuthStrategy('query-param');
    const result = strategy.sign({ apiKey: 'qk-test' }, { method: 'POST', url: 'https://api.example.com' });
    assert.equal(result.queryParams?.['key'], 'qk-test');
  });

  it('jwt-hs256 produces a valid JWT structure', () => {
    const strategy = getAuthStrategy('jwt-hs256');
    const result = strategy.sign(
      { accessKey: 'ak-test', secretKey: 'sk-test' },
      { method: 'POST', url: 'https://api.example.com' },
    );
    const token = result.headers?.['Authorization']?.replace('Bearer ', '');
    assert.ok(token);
    const parts = token.split('.');
    assert.equal(parts.length, 3, 'JWT should have 3 parts');
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    assert.equal(header.alg, 'HS256');
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    assert.equal(payload.iss, 'ak-test');
    assert.ok(payload.exp > payload.iat);
  });

  it('hmac-sha256-v4 produces Authorization header', () => {
    const strategy = getAuthStrategy('hmac-sha256-v4');
    const result = strategy.sign(
      { accessKey: 'ak', secretKey: 'sk', region: 'cn-north-1', service: 'cv' },
      { method: 'POST', url: 'https://visual.volcengineapi.com/', body: '{}' },
    );
    assert.ok(result.headers?.['Authorization']?.startsWith('HMAC-SHA256'));
    assert.ok(result.headers?.['X-Date']);
    assert.ok(result.headers?.['X-Content-Sha256']);
  });

  it('throws on unknown auth type', () => {
    assert.throws(() => getAuthStrategy('unknown'), /Unknown auth type/);
  });
});

// ── Protocol template schema validation ──

describe('ProtocolTemplateSchema', () => {
  it('validates a minimal async template', () => {
    const template = {
      name: 'test',
      version: 1,
      mode: 'async',
      capabilities: {
        text2video: {
          submit: {
            method: 'POST',
            path: '/api/v1/generate',
            body: { prompt: '{{prompt}}' },
            response: { taskId: '$.id' },
          },
          poll: {
            method: 'GET',
            path: '/api/v1/status/{{taskId}}',
            response: {
              status: '$.status',
              statusMap: { succeeded: ['done'], failed: ['error'] },
              resultUrl: '$.result_url',
            },
          },
        },
      },
    };
    const result = ProtocolTemplateSchema.parse(template);
    assert.equal(result.name, 'test');
    assert.equal(result.mode, 'async');
  });

  it('validates a minimal sync template', () => {
    const template = {
      name: 'test-sync',
      version: 1,
      mode: 'sync',
      capabilities: {
        analyze: {
          request: {
            method: 'POST',
            path: '/api/v1/analyze',
            body: { prompt: '{{prompt}}' },
            response: { result: '$.result' },
          },
        },
      },
    };
    const result = ProtocolTemplateSchema.parse(template);
    assert.equal(result.mode, 'sync');
  });

  it('rejects template without name', () => {
    assert.throws(() => ProtocolTemplateSchema.parse({ version: 1, mode: 'async', capabilities: {} }));
  });

  it('rejects invalid mode', () => {
    assert.throws(() => ProtocolTemplateSchema.parse({ name: 'x', version: 1, mode: 'streaming', capabilities: {} }));
  });
});

// ── YAML loader ──

describe('loadProtocolTemplate', () => {
  it('loads and validates a YAML protocol file', () => {
    const tmpDir = mkdtempSync(join(os.tmpdir(), 'proto-test-'));
    const yamlContent = [
      'name: test-proto',
      'version: 1',
      'mode: async',
      'capabilities:',
      '  text2video:',
      '    submit:',
      '      method: POST',
      '      path: /api/generate',
      '      response:',
      '        taskId: $.id',
      '    poll:',
      '      method: GET',
      '      path: /api/status/{{taskId}}',
      '      response:',
      '        status: $.status',
      '        statusMap:',
      '          succeeded: [done]',
      '        resultUrl: $.url',
    ].join('\n');
    const filePath = join(tmpDir, 'test.yaml');
    writeFileSync(filePath, yamlContent);

    const template = loadProtocolTemplate(filePath);
    assert.equal(template.name, 'test-proto');
    assert.equal(template.mode, 'async');
    assert.ok(template.capabilities['text2video']);
  });
});

describe('loadProtocolsFromDir', () => {
  it('loads all YAML files from directory', () => {
    const tmpDir = mkdtempSync(join(os.tmpdir(), 'proto-dir-test-'));
    writeFileSync(
      join(tmpDir, 'a.yaml'),
      'name: proto-a\nversion: 1\nmode: async\ncapabilities:\n  gen:\n    submit:\n      method: POST\n      path: /a\n      response:\n        taskId: $.id\n    poll:\n      method: GET\n      path: /a/{{taskId}}\n      response:\n        status: $.s\n        resultUrl: $.u',
    );
    writeFileSync(
      join(tmpDir, 'b.yml'),
      'name: proto-b\nversion: 1\nmode: sync\ncapabilities:\n  analyze:\n    request:\n      method: POST\n      path: /b\n      response:\n        result: $.r',
    );

    const templates = loadProtocolsFromDir(tmpDir);
    assert.equal(templates.size, 2);
    assert.ok(templates.has('proto-a'));
    assert.ok(templates.has('proto-b'));
  });

  it('returns empty map for nonexistent dir', () => {
    const templates = loadProtocolsFromDir('/nonexistent/path');
    assert.equal(templates.size, 0);
  });
});

// ── Real protocol template validation ──

describe('real protocol templates', () => {
  const protocolsDir = join(import.meta.dirname, '../../../plugins');

  it('video-gen protocols all validate', () => {
    const dir = join(protocolsDir, 'video-gen/protocols');
    const templates = loadProtocolsFromDir(dir);
    assert.ok(templates.size >= 3, `Expected ≥3 video-gen protocols, got ${templates.size}`);
    for (const [name, t] of templates) {
      assert.equal(t.mode, 'async', `${name} should be async`);
      assert.ok(t.capabilities['text2video'], `${name} should have text2video`);
    }
  });

  it('video-analysis protocols all validate', () => {
    const dir = join(protocolsDir, 'video-analysis/protocols');
    const templates = loadProtocolsFromDir(dir);
    assert.ok(templates.size >= 2, `Expected ≥2 video-analysis protocols, got ${templates.size}`);
    for (const [name, t] of templates) {
      assert.equal(t.mode, 'sync', `${name} should be sync`);
      assert.ok(t.capabilities['analyze'] || t.capabilities['analyze_url'], `${name} should have analyze capability`);
    }
  });
});
