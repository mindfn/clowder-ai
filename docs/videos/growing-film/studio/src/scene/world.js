// The world tree (crown + roots), forest variants, foliage clumps and wind.

import { buildTree, evaluate, foliage } from '../tree.js';
import { clamp, smoothstep, rng } from '../util.js';

export function hillRaw(x) {
  return 1.1 * Math.exp((-x * x) / 1800) + 0.35 * Math.sin(x * 0.045 + 1.3) + 0.18 * Math.sin(x * 0.11 + 0.4) + 0.06 * Math.sin(x * 0.37 + 2.0) - 0.00009 * x * x;
}
const H0 = hillRaw(0);
/** Ground surface height; identical to GLSL hill() in shaders/common.js. */
export const hill = (x) => hillRaw(x) - H0;

function trunkPath(h = 15.6, step = 0.6, bend = 1.1) {
  const pts = [];
  for (let y = 0; y <= h + 1e-6; y += step) pts.push([Math.sin(y * 0.16) * bend - 0.35 * Math.sin(y * 0.45) * (bend / 1.1), y]);
  return pts;
}

export function buildWorldTree() {
  const crownPuffs = [
    [0, 42, 30, 14], [-26, 34, 20, 11], [26, 34, 20, 11], [-42, 27, 13, 8],
    [42, 27, 13, 8], [-12, 50, 18, 9], [14, 49, 18, 9], [0, 30, 16, 8],
  ];
  const crown = buildTree({
    seed: 11, kind: 'crown', start: trunkPath(), tropism: [0, 0.1], flare: 0.75, rTip: 0.045, pipeK: 0.85,
    phases: [
      { puffs: crownPuffs, attractors: 70, seg: 1.4, influence: 34, kill: 8.5, jitter: 0.06, canSprout: (x, y) => y > 14.5, maxLateral: 0.9, maxBend: 0.35 },
      { puffs: crownPuffs, attractors: 1700, seg: 0.8, influence: 8.5, kill: 1.7, jitter: 0.12, canSprout: (x, y, i) => y > 18 && i % 2 === 0, maxLateral: 0.85, maxBend: 0.45, maxKids: 2 },
    ],
  });
  // roots start at the seed (just below the surface) so nothing pokes above ground
  const rs = [[0, -0.05], [0, -0.4]];
  for (const a of [-170, -140, -112, -90, -66, -38, -10]) {
    const r = (a * Math.PI) / 180;
    rs.push([Math.cos(r) * 1.2, -0.4 + Math.sin(r) * 1.2, 1]);
  }
  const roots = buildTree({
    seed: 5, kind: 'roots', start: rs, rTip: 0.03, pipeK: 0.42, tropism: [0, -0.05],
    phases: [
      { puffs: [[0, -7, 34, 7], [-30, -9, 22, 6], [30, -9, 22, 6], [0, -15, 18, 8]], attractors: 70, seg: 1.2, influence: 22, kill: 6, jitter: 0.25, maxLateral: 0.9, maxBend: 0.5 },
      { puffs: [[0, -6, 30, 6], [-30, -8, 22, 6], [30, -8, 22, 6], [0, -14, 18, 7], [-50, -5, 12, 4], [50, -5, 12, 4]], attractors: 1300, seg: 0.8, influence: 9, kill: 1.7, jitter: 0.3, maxLateral: 0.8, maxBend: 0.55, maxKids: 2, canSprout: (x, y, i) => i % 2 === 0 },
    ],
  });
  return { crown, roots };
}

/** Smaller trees for the forest: same grammar, own seeds and silhouettes. */
export function buildForestTree(seed, scale = 1) {
  const r = rng(seed * 17 + 3);
  const w = 20 + r() * 12;
  const hgt = 26 + r() * 10;
  const puffs = [
    [0, hgt, w * 0.8, 10], [-w * 0.6, hgt - 6, w * 0.5, 7], [w * 0.6, hgt - 6, w * 0.5, 7], [r.range(-6, 6), hgt + 6, w * 0.5, 6],
  ];
  const crown = buildTree({
    seed, kind: 'crown', start: trunkPath(9 + r() * 3, 0.6, 0.6 + r() * 0.8), tropism: [0, 0.12], flare: 0.6, rTip: 0.04, pipeK: 0.75,
    phases: [
      { puffs, attractors: 30, seg: 1.4, influence: 24, kill: 7, jitter: 0.08, canSprout: (x, y) => y > 8.5, maxLateral: 0.9, maxBend: 0.4 },
      { puffs, attractors: 520, seg: 0.9, influence: 8, kill: 1.8, jitter: 0.14, canSprout: (x, y, i) => y > 11 && i % 2 === 0, maxLateral: 0.85, maxBend: 0.45, maxKids: 2 },
    ],
  });
  const rs = [[0, -0.05], [0, -0.4]];
  for (const a of [-160, -120, -90, -60, -20]) {
    const q = (a * Math.PI) / 180;
    rs.push([Math.cos(q), -0.4 + Math.sin(q), 1]);
  }
  const roots = buildTree({
    seed: seed + 1, kind: 'roots', start: rs, rTip: 0.03, pipeK: 0.6, tropism: [0, -0.05],
    phases: [{ puffs: [[0, -5, 22, 5], [0, -9, 12, 5]], attractors: 420, seg: 0.9, influence: 8, kill: 1.8, jitter: 0.3, maxLateral: 0.8, maxBend: 0.55, maxKids: 2 }],
  });
  return { crown, roots, scale };
}

/** Wind: branch displacement grows with path distance, shrinks with girth. */
export function makeSway(t, tree, strength = 1) {
  const maxD = tree.maxD;
  return (x, y, D, order) => {
    const k = Math.pow(clamp(D / maxD), 1.6) * strength;
    const ph = x * 0.07 + y * 0.03;
    return [
      k * (0.35 * Math.sin(t * 0.9 + ph) + 0.12 * Math.sin(t * 2.3 + ph * 3 + order)),
      k * 0.08 * Math.sin(t * 1.7 + ph * 2),
    ];
  };
}

/**
 * Canopy clumps for growth front F. Positions include wind and the tree's
 * placement (ox, oy, scale). Exposure favours clumps facing the key light.
 */
export function canopyClumps(tree, F, { ox = 0, oy = 0, scale = 1, keyDir = [0.4, 0.9], size = 2.25, maxL = 14, sway = null, blossom = 0, alpha = 1, sizeMul = 1 } = {}) {
  const grownFrac = clamp(F / tree.maxD);
  const s = size * (0.18 + 0.82 * smoothstep(0.05, 0.6, grownFrac)) * sizeMul;
  const mL = Math.max(1.2, Math.min(maxL, F * 0.2));
  const raw = foliage(tree, F, { maxL: mL, size: s });
  if (!raw.length) return [];
  let cx = 0;
  let cy = 0;
  for (const c of raw) {
    cx += c.x;
    cy += c.y;
  }
  cx /= raw.length;
  cy /= raw.length;
  let R = 1e-3;
  for (const c of raw) R = Math.max(R, Math.hypot(c.x - cx, c.y - cy));
  const kl = Math.hypot(keyDir[0], keyDir[1]) || 1;
  const out = [];
  const thin = grownFrac > 0.5 ? 2 : 1; // big crowns: fewer, larger masses
  for (let ci = 0; ci < raw.length; ci++) {
    const c = raw[ci];
    if (thin > 1 && c.i % thin === 1 && c.rand < 0.75) continue;
    let x = c.x;
    let y = c.y;
    if (sway) {
      const d = sway(x, y, tree.D[c.i], tree.order[c.i]);
      x += d[0];
      y += d[1];
    }
    const dx = (c.x - cx) / R;
    const dy = (c.y - cy) / R;
    const dl = Math.hypot(dx, dy) || 1;
    const facing = (dx * keyDir[0] + dy * keyDir[1]) / (dl * kl);
    const expo = clamp(0.48 + 0.34 * facing * Math.min(1, dl * 1.3) + 0.22 * dy + 0.2 * (c.rand - 0.5));
    const big = thin > 1 ? 1.25 + 0.5 * (c.rand - 0.5) : 1;
    out.push({ x: ox + x * scale, y: oy + y * scale, r: c.r * scale * big, expo, hue: c.rand, blossom, alpha });
  }
  return out;
}

export { evaluate };
