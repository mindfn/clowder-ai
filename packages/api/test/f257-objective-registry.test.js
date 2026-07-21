/**
 * F257 修复清单 #3 — objective registry loader.
 *
 * 契约（2a R1 修订）：parseObjectiveRegistry 返回 discriminated Result。
 * 合法 → {ok:true, registry:{registryVersion, objectives:[{id,statement}]}}。
 * malformed YAML / 非 mapping / 非正整数 version / objectives 非数组 / 任一非法行
 * （缺/空白 id·statement、id 不匹配 pattern、重复 id）→ {ok:false, error}（fail-closed，
 * 绝不静默塌成空 catalog）。并验 shipped registry.yaml 含 canonized 目标且**无 segments**。
 */

import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const { parseObjectiveRegistry, loadObjectiveRegistry } = await import(
  '../dist/infrastructure/harness-eval/objective-registry.js'
);

const testDir = dirname(fileURLToPath(import.meta.url));
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

describe('F257 #3 — parseObjectiveRegistry (valid)', () => {
  test('parses valid registry (id/statement only — no segments authority)', () => {
    const r = parseObjectiveRegistry('registryVersion: 1\nobjectives:\n  - id: obj-x\n    statement: does x\n');
    assert.equal(r.ok, true);
    assert.equal(r.registry.registryVersion, 1);
    assert.deepEqual(r.registry.objectives, [{ id: 'obj-x', statement: 'does x' }]);
    // segments must NOT be carried through even if authored (single authority)
    assert.equal('segments' in r.registry.objectives[0], false);
  });

  test('trims statement whitespace', () => {
    const r = parseObjectiveRegistry('registryVersion: 2\nobjectives:\n  - id: obj-y\n    statement: "  padded  "\n');
    assert.equal(r.ok, true);
    assert.equal(r.registry.objectives[0].statement, 'padded');
    assert.equal(r.registry.registryVersion, 2);
  });
});

describe('F257 #3 — parseObjectiveRegistry (fail-closed, no silent empty)', () => {
  const cases = [
    ['malformed YAML', ': : [unclosed'],
    ['non-mapping root', '- just\n- a\n- list\n'],
    ['version -2.5 (sol repro)', 'registryVersion: -2.5\nobjectives: []\n'],
    ['version 0', 'registryVersion: 0\nobjectives: []\n'],
    ['version non-integer 1.5', 'registryVersion: 1.5\nobjectives: []\n'],
    ['missing registryVersion', 'objectives: []\n'],
    ['objectives not an array', 'registryVersion: 1\nobjectives: nope\n'],
    ['missing id', 'registryVersion: 1\nobjectives:\n  - statement: no id\n'],
    ['whitespace-only id (sol repro)', 'registryVersion: 1\nobjectives:\n  - id: "   "\n    statement: x\n'],
    ['whitespace-only statement (sol repro)', 'registryVersion: 1\nobjectives:\n  - id: obj-x\n    statement: "   "\n'],
    ['id not matching pattern', 'registryVersion: 1\nobjectives:\n  - id: Routing_Delivery\n    statement: x\n'],
    [
      'duplicate ids (sol repro)',
      'registryVersion: 1\nobjectives:\n  - id: obj-x\n    statement: a\n  - id: obj-x\n    statement: b\n',
    ],
    // 2a R2 P2-1: forbidden/unknown fields must REJECT (not silently strip), so a stray
    // `segments` can't reappear and be mistaken for挂靠 authority.
    [
      'segments field (forbidden, not stripped)',
      'registryVersion: 1\nobjectives:\n  - id: obj-x\n    statement: x\n    segments: [S1, D1]\n',
    ],
    ['unknown entry key', 'registryVersion: 1\nobjectives:\n  - id: obj-x\n    statement: x\n    weight: 3\n'],
    ['unknown root key', 'registryVersion: 1\nfoo: bar\nobjectives: []\n'],
  ];
  for (const [name, yaml] of cases) {
    test(`rejects: ${name}`, () => {
      const r = parseObjectiveRegistry(yaml);
      assert.equal(r.ok, false, `${name} must fail-closed`);
      assert.equal(typeof r.error, 'string');
      assert.ok(r.error.length > 0, 'error reason is non-empty');
    });
  }

  test('segments rejection is descriptive (points to UnitEvaluationManifest authority)', () => {
    const r = parseObjectiveRegistry(
      'registryVersion: 1\nobjectives:\n  - id: obj-x\n    statement: x\n    segments: [S1]\n',
    );
    assert.equal(r.ok, false);
    assert.match(r.error, /segments/);
    assert.match(r.error, /UnitEvaluationManifest/);
  });

  test('valid-but-empty objectives is honestly ok (not a failure)', () => {
    const r = parseObjectiveRegistry('registryVersion: 1\nobjectives: []\n');
    assert.equal(r.ok, true);
    assert.deepEqual(r.registry.objectives, []);
  });
});

describe('F257 #3 — loadObjectiveRegistry', () => {
  test('nonexistent path → ok:false (fail-closed, distinguishable from empty)', async () => {
    const r = await loadObjectiveRegistry('/no/such/registry.yaml');
    assert.equal(r.ok, false);
    assert.match(r.error, /unreadable/);
  });

  test('shipped registry.yaml → ok, canonized objectives, no segments', async () => {
    const r = await loadObjectiveRegistry(shippedRegistryPath);
    assert.equal(r.ok, true, r.ok ? '' : r.error);
    const ids = r.registry.objectives.map((o) => o.id);
    assert.ok(ids.includes('obj-routing-delivery'), 'obj-routing-delivery registered');
    assert.ok(ids.includes('obj-identity-integrity'), 'obj-identity-integrity registered');
    for (const o of r.registry.objectives) {
      assert.ok(o.id.length > 0 && o.statement.length > 0, `objective ${o.id} has id + statement`);
      assert.equal('segments' in o, false, `objective ${o.id} carries no segments authority`);
    }
  });
});
