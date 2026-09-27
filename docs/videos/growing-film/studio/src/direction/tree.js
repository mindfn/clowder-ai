// The world tree over film time: growth fronts, girth, foliage palette and
// "overnight" leaf renewals, root light, veins, blossoms, and the sprout.

import { keys, ease, clamp, smoothstep, lerp, ramp, spring, mix3 } from '../util.js';
import { evaluate, canopyClumps, makeSway } from '../scene/world.js';
import { leafMix, LEAF, C } from '../palette.js';
import { K } from '../scene/particles.js';
import { CAT_GLOW } from '../scene/cats.js';

const E = ease;
// crown growth front (path distance from the collar)
// prettier-ignore
const CROWN_F = [
  [12.0, 0], [13.1, 0.62, E.outBack], [18.0, 1.25, E.inOutSine],
  [19.5, 5.5, E.inQuad], [21.0, 17, E.linear], [22.5, 30, E.linear], [24.0, 42, E.outQuad],
  [36.0, 62, E.inOutSine], [45.0, 80, E.inOutSine], [54.0, 92, E.outCubic],
];
// prettier-ignore
const ROOT_F = [
  [18.0, 0], [24.0, 12, E.inOutSine],
  [36.0, 26, E.inOutSine], [39.2, 30, E.inOutSine], [44.5, 70, E.inOutCubic],
];

export const crownFront = (t) => keys(CROWN_F, t);
export const rootFront = (t) => keys(ROOT_F, t);

/** Palette and leaf-renewal wave at time t. */
function foliageLook(t) {
  const flips = [
    [22.5, 'summer', 'autumn'],
    [23.25, 'autumn', 'spring'],
    [24.0, 'spring', 'summer'],
  ];
  let pal = leafMix('spring', 'summer', smoothstep(18, 22, t));
  let pal2 = pal;
  let flipR = -10;
  for (const [ft, a, b] of flips) {
    if (t >= ft && t < ft + 0.75) {
      pal = LEAF[a];
      pal2 = LEAF[b];
      flipR = lerp(-4, 75, ramp(t, ft, ft + 0.7, E.inOutSine));
    } else if (t >= ft + 0.75) {
      pal = LEAF[b];
      pal2 = pal;
      flipR = -10;
    }
  }
  if (t >= 24.75) {
    pal = LEAF.summer;
    if (t > 50) pal = leafMix('summer', 'dusk', smoothstep(51, 56, t));
    if (t > 62) pal = leafMix('dusk', 'night', smoothstep(62, 72, t));
    if (t > 72) pal = leafMix('night', 'bloom', smoothstep(72, 78, t));
    pal2 = pal;
  }
  return { pal, pal2, flipR };
}

export function treeAt(S, t, ctx) {
  const { crown, roots } = ctx.world;
  const F = crownFront(t);
  const RF = rootFront(t);
  const L = S.light;
  const windK = t > 18 && t < 24.5 ? 1.8 : t > 36 && t < 40 ? 1.2 : 0.7;
  const sway = makeSway(t, crown, windK);

  // ---- roots (always evaluated; lit from the streams onward)
  evaluate(roots, RF, 1);
  const glowFront = (t - 39.2) * 11;
  S.roots.push({
    tree: roots,
    kind: 'roots',
    bark: [0.04, 0.028, 0.024],
    barkDark: [0.015, 0.011, 0.01],
    barkLit: [0.08, 0.06, 0.05],
    rimCol: mix3(L.rimCol, [0, 0, 0], 0.7),
    glowA: CAT_GLOW.ragdoll,
    glowB: CAT_GLOW.maine,
    glowC: CAT_GLOW.siamese,
    braid: smoothstep(39.5, 41, t) * (1 - smoothstep(50, 58, t)) * 0.9,
    flow: 4.5,
    emis: 1,
    glow: (p) => {
      const D = p[3];
      let g = 0;
      if (t > 39.2) g = Math.max(g, smoothstep(glowFront, glowFront - 3, D) * (0.55 + 0.45 * smoothstep(40, 44, t)));
      if (t > 58) g *= 0.35 + 0.65 * (1 - smoothstep(58, 64, t)) + 0.25 * smoothstep(96, 100, t);
      return g;
    },
    pts: ctx.seedLight ? [ctx.seedLight(t)] : [],
  });

  // ---- crown
  evaluate(crown, F, 1);
  if (F < 6) {
    // a sprout is a whisker, not a pencil
    const m = lerp(0.35, 1, smoothstep(1.2, 6, F));
    for (let i = 0; i < crown.n; i++) crown.rad[i] *= m;
  }
  const veins = smoothstep(43.5, 47, t) * 0.9 * (1 - smoothstep(55, 62, t) * 0.6) + smoothstep(74, 78, t) * 0.5 * (1 - smoothstep(104, 110, t));
  S.crowns.push({
    tree: crown,
    sway,
    bark: [0.13, 0.085, 0.06],
    barkDark: [0.045, 0.032, 0.026],
    barkLit: [0.27, 0.19, 0.13],
    glowA: CAT_GLOW.ragdoll,
    glowB: CAT_GLOW.maine,
    glowC: CAT_GLOW.siamese,
    veins,
    young: 1 - smoothstep(24, 40, t),
    pts: ctx.crownLights ? ctx.crownLights(t) : [],
  });

  // ---- foliage
  const fl = foliageLook(t);
  if (F > 1.6) {
    const clumps = canopyClumps(crown, F, { keyDir: L.keyDir, sway, blossom: 1 });
    const blossom = smoothstep(75, 79.5, t) * (1 - smoothstep(112, 118, t) * 0.5);
    S.canopies.push({
      clumps,
      pal: fl.pal,
      pal2: fl.pal2,
      flipC: [0, 18],
      flipR: fl.flipR,
      thresh: 0.42,
      backlit: t > 50 && t < 68 ? 0.6 * smoothstep(50, 55, t) : 0.1,
      leafScale: 2.3,
      blossom,
      blossomCol: [2.2, 1.6, 0.9],
      blossomCol2: [1.6, 1.1, 2.2],
      alpha: smoothstep(1.6, 3.5, F),
    });
  }

  // ---- the sprout's seed leaves
  if (F > 0.05 && t < 20) {
    const tip = tipOf(crown);
    const open = spring(t, 12.35, 1.2, 4.5);
    const fade = 1 - smoothstep(17.5, 19.5, t);
    const size = 0.1 + 0.14 * smoothstep(12.2, 16, t);
    for (const side of [-1, 1]) {
      const ang = side * (0.15 + 1.0 * clamp(open));
      const lx = tip[0] + Math.sin(ang) * size * 0.9;
      const ly = tip[1] + Math.cos(ang) * size * 0.9 - 0.01;
      S.parts.mid.push(lx, ly, 0.01, size, 0.3, 0.75, 0.25, fade * smoothstep(12.2, 12.5, t), -ang, K.leaf, 1, 0.6 + side * 0.2);
    }
  }
  if (t > 9.6 && t < 19.5) {
    const g = smoothstep(9.8, 13.5, t);
    const L0 = 0.62 * g;
    const pts = [];
    for (let k = 0; k <= 16; k++) {
      const u = k / 16;
      const d = u * L0;
      pts.push([Math.sin(d * 5.0) * 0.05 + d * 0.08, -0.36 - d, (1 - u) * 0.9 + 0.1, 1]);
    }
    const lit = 1 - smoothstep(15, 19, t);
    S.ribbonsUnder.push({ pts, width: 0.012, color: [0.9, 0.55, 0.25, 1], core: 1.4, alpha: 0.9 * lit, premul: true });
    for (const side of [-1, 1]) {
      const rl = [];
      const g2 = smoothstep(11.2, 14.5, t);
      for (let k = 0; k <= 8; k++) {
        const u = k / 8;
        const d = u * 0.22 * g2;
        rl.push([side * d * 1.2 + 0.03, -0.62 - d * 0.6 + Math.sin(d * 9) * 0.02, (1 - u) * 0.8 + 0.2, 1]);
      }
      S.ribbonsUnder.push({ pts: rl, width: 0.008, color: [0.8, 0.5, 0.25, 1], core: 1.2, alpha: 0.8 * lit * g2, premul: true });
    }
  }
  S.crownF = F;
  S.rootF = RF;
}

/** Current tip of the main stem (for the sprout). */
export function tipOf(tree) {
  const chain = tree.chains[0];
  let last = chain[0];
  for (const i of chain) {
    if (tree.vis[i] <= 0) break;
    last = i;
  }
  const p = tree.P[last];
  if (p >= 0 && tree.vis[last] < 1) {
    return [lerp(tree.X[p], tree.X[last], tree.vis[last]), lerp(tree.Y[p], tree.Y[last], tree.vis[last])];
  }
  return [tree.X[last], tree.Y[last]];
}
