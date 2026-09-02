/* Clowder AI — Roadmap Tree: painted-tree anchor extraction (dev tool).
 *
 * The painted tree (site/assets/roadmap/tree/tree-wood-v2.png) is the truth source
 * for where branches actually are, so foliage must not be guessed from the
 * procedural skeleton. This reads the artwork's alpha channel, finds every twig
 * tip, assigns each tip to the limb it actually grows from (geodesic walk through
 * the wood, not a bounding box — the painted limbs interleave), and writes
 * tree-anchors.json for the renderer.
 *
 * Re-run it whenever the artwork changes:
 *   node site/tools/extract-tree-anchors.mjs
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAlpha } from './png-alpha.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ART = join(HERE, '../assets/roadmap/tree/tree-wood-v2.png');
const OUT = join(HERE, '../assets/roadmap/tree/tree-anchors.json');

const GROUND = 900; // artwork row the ground line sits on (docs/design/roadmap-tree-assets.md)
const TRUNK_X = 800; // artwork column of the trunk axis
const TRUNK_HALF = 80; // stay this far off the axis when hunting for a limb stem
const R = 24; // half-window used to measure how one-sided a pixel's neighbourhood is
const MAX_FILL = 0.13; // reject anything thicker than a twig (trunk, limb joints)
const MIN_LEAN = 0.3; // how far the local centre of mass must sit off the pixel
const MIN_GAP = 38; // suppress tips closer than this to an already-kept tip
const SKIRT = 180; // ignore "tips" this close to the ground: root flare, not twigs
const SPRIG_R = 16; // half-window used to read the local branch axis at a mid-twig point
const SPRIG_GAP = 20; // spacing between mid-twig leaf anchors
const SPRIG_FILL = 0.3; // a twig fills more of the smaller sprig window than of the tip window
const SPRIG_CLEAR = 26; // keep mid-twig anchors clear of the tips

// Where to look for each limb's main stem. Order matches roadmap-tree-data.js.
// The seed itself is the thickest wood in the region, so it lands on the stem
// rather than a twig; only these coarse regions need revisiting if the art moves.
const LIMB_REGIONS = [
  { id: 'memory', region: [380, 430, 760, 760] },
  { id: 'harness', region: [860, 430, 1220, 760] },
  { id: 'capability', region: [430, 120, 780, 430] },
  { id: 'life', region: [840, 120, 1180, 430] },
];

/** Summed-area table so every window query below is O(1). */
function integral(values, w, h) {
  const sum = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y += 1) {
    let row = 0;
    for (let x = 0; x < w; x += 1) {
      row += values[y * w + x];
      sum[(y + 1) * (w + 1) + x + 1] = sum[y * (w + 1) + x + 1] + row;
    }
  }
  return sum;
}

const windowSum = (sum, w, x0, y0, x1, y1) =>
  sum[(y1 + 1) * (w + 1) + x1 + 1] - sum[y0 * (w + 1) + x1 + 1] - sum[(y1 + 1) * (w + 1) + x0] + sum[y0 * (w + 1) + x0];

/** Twig tips: thin wood whose neighbourhood mass all sits to one side. */
function findTips(mask, sums, w, h) {
  const { sMask, sX, sY } = sums;
  const area = (2 * R + 1) ** 2;
  const found = [];
  for (let y = R; y < Math.min(h, GROUND - SKIRT); y += 1) {
    for (let x = R; x < w - R; x += 1) {
      if (!mask[y * w + x]) continue;
      const n = windowSum(sMask, w, x - R, y - R, x + R, y + R);
      if (n < 12 || n > area * MAX_FILL) continue;
      const dx = windowSum(sX, w, x - R, y - R, x + R, y + R) / n - x;
      const dy = windowSum(sY, w, x - R, y - R, x + R, y + R) / n - y;
      const lean = Math.hypot(dx, dy) / R;
      if (lean < MIN_LEAN) continue;
      found.push({ x, y, lean, dx: -dx, dy: -dy });
    }
  }
  found.sort((a, b) => b.lean - a.lean);
  const kept = [];
  for (const p of found) {
    if (kept.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < MIN_GAP)) continue;
    const len = Math.hypot(p.dx, p.dy) || 1;
    kept.push({ x: p.x, y: p.y, ux: +(p.dx / len).toFixed(3), uy: +(p.dy / len).toFixed(3) });
  }
  return kept;
}

/**
 * Mid-twig anchors: thin wood that is not an endpoint, tagged with the normal of the
 * local branch axis (from the neighbourhood's principal direction) so leaves can be
 * scattered to either side of the branch instead of only at its tip.
 */
function findSprigs(mask, sums, w, h, tips) {
  const { sMask, sX, sY, sXX, sYY, sXY } = sums;
  const area = (2 * SPRIG_R + 1) ** 2;
  const found = [];
  for (let y = SPRIG_R; y < Math.min(h, GROUND - SKIRT); y += 2) {
    for (let x = SPRIG_R; x < w - SPRIG_R; x += 2) {
      if (!mask[y * w + x]) continue;
      const box = [x - SPRIG_R, y - SPRIG_R, x + SPRIG_R, y + SPRIG_R];
      const n = windowSum(sMask, w, ...box);
      if (n < 10 || n > area * SPRIG_FILL) continue;
      const mx = windowSum(sX, w, ...box) / n;
      const my = windowSum(sY, w, ...box) / n;
      const cxx = windowSum(sXX, w, ...box) / n - mx * mx;
      const cyy = windowSum(sYY, w, ...box) / n - my * my;
      const cxy = windowSum(sXY, w, ...box) / n - mx * my;
      const angle = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
      found.push({ x, y, n, nx: -Math.sin(angle), ny: Math.cos(angle) });
    }
  }
  found.sort((a, b) => a.n - b.n);
  const kept = [];
  for (const p of found) {
    if (tips.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < SPRIG_CLEAR)) continue;
    if (kept.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < SPRIG_GAP)) continue;
    kept.push({ x: p.x, y: p.y, nx: +p.nx.toFixed(3), ny: +p.ny.toFixed(3) });
  }
  return kept;
}

/** Thickest wood inside a region, kept clear of the trunk axis: a limb's stem. */
function findSeed(mask, sMask, w, region) {
  const [x0, y0, x1, y1] = region;
  let best = null;
  for (let y = y0; y <= y1; y += 2) {
    for (let x = x0; x <= x1; x += 2) {
      if (!mask[y * w + x]) continue;
      if (Math.abs(x - TRUNK_X) < TRUNK_HALF && y > 380) continue;
      const f = windowSum(sMask, w, x - 10, y - 10, x + 10, y + 10);
      if (!best || f > best.f) best = { x, y, f };
    }
  }
  if (!best) throw new Error(`no wood found in region ${region.join(',')}`);
  return best;
}

const NEIGHBOURS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

/** Multi-source BFS through the wood: every pixel belongs to its nearest stem.
 * Walks 8-connected over a softer mask so hairline twigs stay attached. */
function labelLimbs(mask, w, h, seeds) {
  const label = new Int8Array(w * h).fill(-1);
  const depth = new Int32Array(w * h).fill(-1);
  const queue = new Int32Array(w * h);
  let head = 0;
  let tail = 0;
  seeds.forEach((seed, i) => {
    const idx = seed.y * w + seed.x;
    label[idx] = i;
    depth[idx] = 0;
    queue[tail] = idx;
    tail += 1;
  });
  while (head < tail) {
    const idx = queue[head];
    head += 1;
    const x = idx % w;
    const y = (idx - x) / w;
    for (const [dx, dy] of NEIGHBOURS) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const n = ny * w + nx;
      if (!mask[n] || label[n] !== -1) continue;
      label[n] = label[idx];
      depth[n] = depth[idx] + 1;
      queue[tail] = n;
      tail += 1;
    }
  }
  return { label, depth };
}

/** A few painted twigs float free of the wood mass; adopt the nearest limb. */
function adoptOrphan(label, depth, w, h, p) {
  for (let r = 2; r <= 90; r += 2) {
    let best = null;
    for (let dy = -r; dy <= r; dy += 1) {
      for (let dx = -r; dx <= r; dx += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = p.x + dx;
        const y = p.y + dy;
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        const idx = y * w + x;
        if (label[idx] < 0) continue;
        const dist = Math.hypot(dx, dy);
        if (!best || dist < best.dist) best = { dist, label: label[idx], depth: depth[idx] };
      }
    }
    if (best) return best;
  }
  return null;
}

function main() {
  const { width: w, height: h, alpha } = readAlpha(ART);
  const mask = new Float64Array(w * h);
  const soft = new Uint8Array(w * h);
  const fields = { mx: new Float64Array(w * h), my: new Float64Array(w * h) };
  fields.mxx = new Float64Array(w * h);
  fields.myy = new Float64Array(w * h);
  fields.mxy = new Float64Array(w * h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = y * w + x;
      if (alpha[i] > 16) soft[i] = 1;
      if (alpha[i] <= 64) continue;
      mask[i] = 1;
      fields.mx[i] = x;
      fields.my[i] = y;
      fields.mxx[i] = x * x;
      fields.myy[i] = y * y;
      fields.mxy[i] = x * y;
    }
  }
  const sums = {
    sMask: integral(mask, w, h),
    sX: integral(fields.mx, w, h),
    sY: integral(fields.my, w, h),
    sXX: integral(fields.mxx, w, h),
    sYY: integral(fields.myy, w, h),
    sXY: integral(fields.mxy, w, h),
  };
  const seeds = LIMB_REGIONS.map((limb) => findSeed(mask, sums.sMask, w, limb.region));
  const { label, depth } = labelLimbs(soft, w, h, seeds);
  const tips = findTips(mask, sums, w, h);
  const sprigs = findSprigs(mask, sums, w, h, tips);
  let orphans = 0;
  const own = (p) => {
    const idx = p.y * w + p.x;
    if (label[idx] >= 0) return { ...p, limb: label[idx], d: depth[idx] };
    const adopted = adoptOrphan(label, depth, w, h, p);
    if (!adopted) return null;
    orphans += 1;
    return { ...p, limb: adopted.label, d: adopted.depth };
  };
  const owned = tips.map(own);
  const ownedSprigs = sprigs.map(own);
  const limbs = LIMB_REGIONS.map((limb, i) => ({
    id: limb.id,
    seed: [seeds[i].x, seeds[i].y],
    tips: owned
      .filter((p) => p && p.limb === i)
      .map(({ x, y, ux, uy, d }) => ({ x, y, ux, uy, d }))
      .sort((a, b) => b.d - a.d),
    sprigs: ownedSprigs
      .filter((p) => p && p.limb === i)
      .map(({ x, y, nx, ny }) => ({ x, y, nx, ny })),
  }));
  const loose = owned.filter((p) => !p);
  const payload = {
    art: 'tree-wood-v2.png',
    size: [w, h],
    ground: GROUND,
    generatedBy: 'site/tools/extract-tree-anchors.mjs',
    limbs,
  };
  writeFileSync(OUT, `${JSON.stringify(payload, null, 2)}\n`);
  process.stdout.write(
    `tips=${tips.length} sprigs=${sprigs.length} ${limbs
      .map((l) => `${l.id}=${l.tips.length}+${l.sprigs.length}`)
      .join(' ')} adopted=${orphans} unassigned=${loose.length}\n-> ${OUT}\n`,
  );
}

main();
