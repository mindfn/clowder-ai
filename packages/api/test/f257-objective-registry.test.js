/**
 * F257 修复清单 #3 — objective registry loader.
 *
 * 契约：parseObjectiveRegistry 从 YAML 解析 objective 定义（id/statement/segments），
 * 丢弃 malformed 行（缺 id/statement）而不抛，malformed YAML → 空 registry。
 * 并验 shipped registry.yaml 含 canonized 目标（obj-routing-delivery /
 * obj-identity-integrity），供 report_harness_signal 只读发现（取代考古）。
 */

import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const { parseObjectiveRegistry, loadObjectiveRegistry } = await import(
  '../dist/infrastructure/harness-eval/objective-registry.js'
);

const testDir = dirname(fileURLToPath(import.meta.url));
// packages/api/test → up 3 → worktree root → docs/harness-feedback/objectives/registry.yaml
const shippedRegistryPath = resolve(
  testDir,
  '..',
  '..',
  '..',
  'docs',
  'harness-feedback',
  'objectives',
  'registry.yaml',
);

describe('F257 #3 — parseObjectiveRegistry', () => {
  test('parses valid registry (id/statement/segments)', () => {
    const r = parseObjectiveRegistry(
      'registryVersion: 1\nobjectives:\n  - id: obj-x\n    statement: does x\n    segments: [S1, D1]\n',
    );
    assert.equal(r.registryVersion, 1);
    assert.equal(r.objectives.length, 1);
    assert.deepEqual(r.objectives[0], { id: 'obj-x', statement: 'does x', segments: ['S1', 'D1'] });
  });

  test('drops malformed entries (missing id or statement), keeps good ones', () => {
    const r = parseObjectiveRegistry(
      'objectives:\n  - id: obj-good\n    statement: ok\n  - statement: no-id\n  - id: no-statement\n',
    );
    assert.equal(r.objectives.length, 1);
    assert.equal(r.objectives[0].id, 'obj-good');
    assert.deepEqual(r.objectives[0].segments, []);
  });

  test('missing objectives array → empty list, default version 1', () => {
    assert.deepEqual(parseObjectiveRegistry('registryVersion: 2\n'), { registryVersion: 2, objectives: [] });
  });

  test('malformed YAML → empty registry (no throw)', () => {
    assert.deepEqual(parseObjectiveRegistry(': : [unclosed'), { registryVersion: 1, objectives: [] });
  });
});

describe('F257 #3 — loadObjectiveRegistry', () => {
  test('nonexistent path → empty registry (fail-safe, no throw)', async () => {
    assert.deepEqual(await loadObjectiveRegistry('/no/such/registry.yaml'), { registryVersion: 1, objectives: [] });
  });

  test('shipped registry.yaml exposes the canonized objectives', async () => {
    const reg = await loadObjectiveRegistry(shippedRegistryPath);
    const ids = reg.objectives.map((o) => o.id);
    assert.ok(ids.includes('obj-routing-delivery'), 'obj-routing-delivery registered');
    assert.ok(ids.includes('obj-identity-integrity'), 'obj-identity-integrity registered');
    // every entry is well-formed
    for (const o of reg.objectives) {
      assert.ok(o.id.length > 0 && o.statement.length > 0, `objective ${o.id} has id + statement`);
      assert.ok(Array.isArray(o.segments), `objective ${o.id} has segments array`);
    }
  });
});
