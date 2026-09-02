/**
 * Roadmap tree regression tests.
 *
 * Covers:
 *  - Logical tree integrity (bilingual labels, valid status, unique ids)
 *  - Geometry determinism (same data + seed → same skeleton) and completeness
 *    (every fruit / limb / root in the data grows a matching element)
 *  - Growth timeline monotonicity (chapters grow in order, panorama = fully grown)
 *  - Page invariants (roadmap.html loads the classic libs in the right order)
 *
 * Run: node --test site/roadmap-tree.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import vm from 'node:vm';

const SITE = resolve(dirname(new URL(import.meta.url).pathname));
const read = (name) => readFileSync(resolve(SITE, name), 'utf8');

function loadLibs() {
  const sandbox = {};
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const lib of ['lib/roadmap-tree-data.js', 'lib/roadmap-tree-geometry.js', 'lib/roadmap-tree-skeleton.js']) {
    vm.runInContext(read(lib), sandbox);
  }
  return sandbox;
}

const { ClowderRoadmapTree: data, ClowderRoadmapGeometry: geo } = loadLibs();

describe('logical tree integrity', () => {
  const isText = (v) => v && typeof v.en === 'string' && v.en.length > 0 && typeof v.zh === 'string' && v.zh.length > 0;

  it('has four capability branches, each with three limbs of three fruits', () => {
    assert.equal(data.branches.length, 4);
    for (const b of data.branches) {
      assert.equal(b.limbs.length, 3, `${b.id} limbs`);
      for (const l of b.limbs) assert.equal(l.fruits.length, 3, `${b.id} fruits`);
    }
  });

  it('labels are bilingual and statuses are valid', () => {
    for (const b of data.branches) {
      assert.ok(isText(b.label) && isText(b.tagline), b.id);
      for (const l of b.limbs) {
        assert.ok(isText(l.label));
        for (const f of l.fruits) {
          assert.ok(isText(f.label));
          assert.ok(data.STATUS.includes(f.status), `${f.label.en}: ${f.status}`);
        }
      }
    }
    for (const r of data.roots) assert.ok(isText(r.label) && r.items.every(isText));
    for (const p of data.trunk.phases) assert.ok(isText(p.label) && p.items.every(isText));
    for (const c of data.crown) assert.ok(isText(c.label) && isText(c.body));
  });

  it('branch and root ids are unique', () => {
    const ids = [...data.branches.map((b) => b.id), ...data.roots.map((r) => r.id)];
    assert.equal(new Set(ids).size, ids.length);
  });

  it('ships three cats with distinct family colors', () => {
    assert.equal(data.cats.length, 3);
    assert.equal(new Set(data.cats.map((c) => c.family)).size, 3);
  });
});

describe('geometry', () => {
  const tree = geo.build(data, 7);

  it('is deterministic for the same seed', () => {
    const again = geo.build(data, 7);
    assert.deepEqual(
      again.nodes.map((n) => n.pts),
      tree.nodes.map((n) => n.pts),
    );
    assert.deepEqual(
      again.fruits.map((f) => [f.x, f.y]),
      tree.fruits.map((f) => [f.x, f.y]),
    );
  });

  it('changes with the seed (no hard-coded skeleton)', () => {
    const other = geo.build(data, 8);
    assert.notDeepEqual(other.nodes.find((n) => n.kind === 'L1').pts, tree.nodes.find((n) => n.kind === 'L1').pts);
  });

  it('grows one fruit per leaf-level feature and one twig per fruit', () => {
    const featureCount = data.branches.reduce((n, b) => n + b.limbs.reduce((m, l) => m + l.fruits.length, 0), 0);
    assert.equal(tree.fruits.length, featureCount);
    assert.equal(tree.nodes.filter((n) => n.kind === 'L3').length, featureCount);
    assert.equal(tree.nodes.filter((n) => n.kind === 'L2').length, 12);
    assert.equal(tree.nodes.filter((n) => n.kind === 'L1').length, 4);
    assert.equal(tree.nodes.filter((n) => n.kind === 'root').length, data.roots.length);
    assert.equal(tree.crown.length, data.crown.length);
  });

  it('keeps every point inside the viewBox', () => {
    for (const n of tree.nodes) {
      for (const p of n.pts) {
        assert.ok(
          p.x >= 0 && p.x <= geo.VIEW.w && p.y >= 0 && p.y <= geo.VIEW.h,
          `${n.id} out of view (${p.x},${p.y})`,
        );
      }
    }
  });

  it('grows in chapter order: roots < trunk < branches < crown', () => {
    const maxG = (kind) => Math.max(...tree.nodes.filter((n) => n.kind === kind).map((n) => n.g1));
    const minG = (kind) => Math.min(...tree.nodes.filter((n) => n.kind === kind).map((n) => n.g0));
    assert.ok(maxG('root') < minG('trunk'));
    assert.ok(maxG('trunk') <= minG('L1'));
    assert.ok(maxG('L3') < minG('crown'));
    for (const n of tree.nodes) {
      assert.equal(geo.progress(n, 8), 1, `${n.id} must be fully grown in the panorama`);
      assert.equal(geo.progress(n, 0), 0, `${n.id} must be absent before the seed is planted`);
    }
    for (const n of tree.nodes.filter((x) => x.kind === 'L2')) {
      const parent = tree.byId.get(n.parent);
      assert.ok(n.g0 >= parent.g0, `${n.id} cannot grow before its limb starts`);
    }
  });
});

describe('roadmap.html invariants', () => {
  let cached;
  const page = () => {
    cached ??= read('roadmap.html');
    return cached;
  };

  it('does not use the runtime Tailwind CDN', () => {
    assert.doesNotMatch(page(), /cdn\.tailwindcss\.com/);
  });

  it('loads data → geometry → skeleton → render → cats → story before use', () => {
    const order = [
      'lib/roadmap-tree-data.js',
      'lib/roadmap-tree-geometry.js',
      'lib/roadmap-tree-skeleton.js',
      'lib/roadmap-tree-render.js',
      'lib/roadmap-tree-cats.js',
      'lib/roadmap-tree-story.js',
    ];
    const html = page();
    const idx = order.map((f) => html.indexOf(f));
    for (let i = 0; i < idx.length; i += 1) {
      assert.ok(idx[i] > -1, `${order[i]} must be loaded`);
      if (i) assert.ok(idx[i] > idx[i - 1], `${order[i]} must load after ${order[i - 1]}`);
    }
  });

  it('declares nine story chapters matching the growth timeline', () => {
    const html = page();
    const chapters = html.match(/<section class="rt-chapter[^"]*" data-chapter="\d"/g) || [];
    assert.equal(chapters.length, 9);
    assert.match(read('roadmap.css'), /prefers-reduced-motion|\.rt-reduced/, 'reduced-motion styles must exist');
    assert.match(
      read('lib/roadmap-tree-story.js'),
      /prefers-reduced-motion/,
      'story engine must honour reduced motion',
    );
  });
});
