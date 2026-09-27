// Act 6 — 森林 / the forest (a stated belief, not a product claim). The fruit
// 不再从零开始 falls, rolls down the hill and sprouts; a forest rises, every
// tree with its own roots, joined only by thin shared threads; under one aurora
// the camera rises into the stars, which gather into the three-cat mark.

import { FRUITS, fruitAnchor } from './act5.js';
import { hill, buildForestTree, canopyClumps, makeSway } from '../scene/world.js';
import { evaluate } from '../tree.js';
import { CAT_GLOW } from '../scene/cats.js';
import { K, burst, ripples, motes, fireflies } from '../scene/particles.js';
import { ramp, ease, smoothstep, lerp, clamp, envelope, keys, rng } from '../util.js';
import { LEAF, leafMix } from '../palette.js';

const E = ease;
export const SPROUT_X = 27.5;

// forest: [x, scale, growth start, seed]
export const FOREST = [
  [SPROUT_X, 0.34, 98.25, 301],
  [-74, 0.56, 99.6, 302],
  [82, 0.6, 99.9, 303],
  [-122, 0.48, 100.3, 304],
  [128, 0.52, 100.6, 305],
  [-166, 0.58, 101.0, 306],
  [170, 0.46, 101.2, 307],
  [-208, 0.44, 101.5, 308],
  [212, 0.5, 101.7, 309],
];

export function buildForest() {
  return FOREST.map(([x, s, at, seed]) => ({ x, s, at, ...buildForestTree(seed, s) }));
}

function fruitPath(t, ctx) {
  const f = FRUITS.find((q) => q.cat === 'siamese');
  const a0 = fruitAnchor(f);
  const a = { x: a0.x, y: a0.top - 0.5 };
  const land1 = [8.6, hill(8.6) + 0.35];
  // fall (96.0 → 96.75), bounce (→ 97.2), roll down the slope (→ 97.9)
  if (t < 96.75) {
    const u = (t - 96.0) / 0.75;
    return [lerp(a.x, land1[0], u), lerp(a.y, land1[1], u * u), u * 3];
  }
  if (t < 97.2) {
    const u = (t - 96.75) / 0.45;
    const x = lerp(land1[0], 12.5, u);
    return [x, hill(x) + 0.35 + Math.sin(Math.PI * u) * 1.2, 3 + u * 3];
  }
  const u = E.outCubic(clamp((t - 97.2) / 0.9));
  const x = lerp(12.5, SPROUT_X, u);
  return [x, hill(x) + 0.35 - 0.7 * smoothstep(97.95, 98.4, t), 6 + u * 12];
}

export function act6(S, t, ctx) {
  if (t < 95.9) return;
  const P = S.parts.mid;
  const L = S.light;
  const col = CAT_GLOW.siamese;

  // ---- the falling fruit
  if (t < 98.6) {
    const [x, y, rot] = fruitPath(t, ctx);
    const sink = smoothstep(97.95, 98.5, t);
    P.push(x, y, 0.04, 0.36 * (1 - 0.5 * sink), col[0] * 0.8, col[1] * 0.8, col[2] * 0.8, 1 - sink * 0.6, rot, K.fruit, 1, 1);
    S.ground.glows.push({ x, y, r: 2.4, i: 1.2, col });
    const pts = [];
    for (let k = 0; k <= 12; k++) {
      const q = fruitPath(Math.max(96.0, t - k * 0.03), ctx);
      pts.push([q[0], q[1], 1 - k / 12, 1 - k / 12]);
    }
    pts.reverse();
    S.ribbons.push({ pts, width: 0.18, color: [...col, 1], core: 1.2, alpha: 0.6 * (1 - sink) });
  }
  burst(P, t, 96.75, { x: 8.6, y: hill(8.6) + 0.1, n: 24, speed: 2.4, life: 1.0, size: 0.05, col, gravity: -3, dir: Math.PI / 2, spread: 2.4, seed: 131 });
  burst(P, t, 98.3, { x: SPROUT_X, y: hill(SPROUT_X), n: 60, speed: 3.2, life: 1.8, size: 0.07, col: [1.8, 1.4, 0.8], gravity: -0.6, dir: Math.PI / 2, spread: 3.0, seed: 133 });
  ripples(P, t, 98.3, { x: SPROUT_X, y: hill(SPROUT_X) + 0.02, count: 3, gap: 0.3, speed: 4, life: 2.2, col, aspect: 0.2 });
  if (t > 98.3 && t < 102) S.ground.ripple = { amt: 1.2 * (1 - smoothstep(98.3, 101.5, t)), c: [SPROUT_X, -0.3], r: (t - 98.3) * 7, col: [1.0, 0.7, 0.3] };

  // ---- the forest
  const auroraCol = [0.25, 1.2, 0.8];
  const pal = leafMix('night', 'bloom', smoothstep(99, 103, t));
  for (const tr of ctx.forest) {
    const g = ramp(t, tr.at, tr.at + 3.2, E.inOutSine);
    if (g <= 0) continue;
    const sc = tr.s * lerp(0.08, 1, E.outCubic(g));
    const F = tr.crown.maxD * clamp(g * 1.4);
    const sway = makeSway(t, tr.crown, 0.8);
    evaluate(tr.crown, F, 1);
    evaluate(tr.roots, tr.roots.maxD * clamp(g * 1.2), 1);
    const oy = hill(tr.x);
    const rootsLit = smoothstep(tr.at + 1.5, tr.at + 3.5, t);
    S.roots.push({
      tree: tr.roots,
      kind: 'roots',
      x: tr.x,
      y: oy,
      scale: sc,
      bark: [0.03, 0.025, 0.022],
      barkDark: [0.012, 0.01, 0.01],
      barkLit: [0.06, 0.05, 0.045],
      glowA: CAT_GLOW.ragdoll,
      glowB: CAT_GLOW.maine,
      glowC: CAT_GLOW.siamese,
      braid: 0.4,
      glow: () => 0.35 * rootsLit,
      flow: 3,
    });
    S.crowns.push({ tree: tr.crown, x: tr.x, y: oy, scale: sc, sway, bark: [0.08, 0.06, 0.05], barkDark: [0.03, 0.025, 0.02], barkLit: [0.14, 0.11, 0.09], veins: 0.4 * rootsLit, glowA: CAT_GLOW.ragdoll, glowB: CAT_GLOW.maine, glowC: CAT_GLOW.siamese });
    if (g > 0.25) {
      const worldR = 2.4 * Math.pow(sc, 0.62);
      const clumps = canopyClumps(tr.crown, F, { keyDir: L.keyDir, sway, blossom: 1, scale: sc, ox: tr.x, oy, size: worldR / sc, maxL: 20 });
      S.canopies.push({ clumps, pal, thresh: 0.42, backlit: 0.3, leafScale: 3.2, blossom: 0.8 * smoothstep(tr.at + 2, tr.at + 4, t), blossomCol: [2.2, 1.6, 0.9], blossomCol2: [1.4, 1.0, 2.2], alpha: smoothstep(0.25, 0.45, g) });
    }
  }
  // shared threads between neighbouring root systems (not a merged root)
  const threadsOn = smoothstep(102.8, 104.8, t);
  if (threadsOn > 0) {
    const xs = [...ctx.forest.map((f) => f.x), 0].sort((a, b) => a - b);
    for (let i = 0; i < xs.length - 1; i++) {
      const a = xs[i];
      const b = xs[i + 1];
      const pts = [];
      const reach = ramp(t, 102.8 + i * 0.12, 104.2 + i * 0.12, E.inOutSine);
      for (let k = 0; k <= 30; k++) {
        const u = (k / 30) * reach;
        const x = lerp(a, b, u);
        const y = lerp(hill(a), hill(b), u) - 6.5 - Math.sin(u * Math.PI) * 3.0 + Math.sin(u * 9 + i) * 0.4;
        pts.push([x, y, 1, 1]);
      }
      if (pts.length > 1) S.ribbonsUnder.push({ pts, width: 0.35, color: [...auroraCol, 1], core: 1.4, alpha: 0.7 * threadsOn, pulseFreq: 0.4, pulseSpeed: 3, pulseAmt: 2 });
    }
  }
  fireflies(P, t, { n: 90, x0: -180, x1: 180, y0: 1, y1: 40, size: 0.35, col: [0.7, 1.1, 0.5], alpha: envelope(t, 100, 103, 108, 111), seed: 21 });

  // ---- the stars gather into the mark
  if (t > 108.5) {
    const lp = ctx.logoPoints;
    const cam = S.cam;
    const unit = cam.V / 1080;
    const size = 400; // logo size on screen, px (matches endcard.js)
    const cx = 960;
    const cy = 680;
    for (let i = 0; i < lp.length; i++) {
      const p = lp[i];
      const k = ramp(t, 108.6 + p.d * 1.2, 110.6 + p.d * 1.3, E.inOutCubic);
      const sx = lerp(p.sx, cx + (p.x - 0.5) * size, k);
      const sy = lerp(p.sy, cy + (0.5 - p.y) * size, k);
      const wx = cam.x + (sx - 960) * unit;
      const wy = cam.y + (sy - 540) * unit;
      const fade = 1 - ramp(t, 112.2, 114.0);
      const tw = 0.6 + 0.4 * Math.sin(t * 6 + i);
      P.push(wx, wy, 0, unit * lerp(3.0, 1.8, k), 2.2, 1.5, 0.9, (0.55 + 0.45 * k) * fade * tw, 0, K.glow);
    }
  }
}

/** Sample the logo's opaque pixels into target points with random star origins. */
export async function logoPoints(url, n = 900) {
  const img = new Image();
  img.src = url;
  await img.decode();
  const c = document.createElement('canvas');
  const s = 200;
  c.width = s;
  c.height = s;
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0, s, s);
  const d = g.getImageData(0, 0, s, s).data;
  const cand = [];
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) if (d[(y * s + x) * 4 + 3] > 128) cand.push([x / s, y / s]);
  const r = rng(99);
  const out = [];
  for (let i = 0; i < n; i++) {
    const [x, y] = cand[Math.floor(r() * cand.length)];
    const a = r() * Math.PI * 2;
    const rr = 300 + r() * 900;
    out.push({ x, y, sx: 960 + Math.cos(a) * rr * 1.4, sy: 600 + Math.sin(a) * rr, d: r() });
  }
  return out;
}
