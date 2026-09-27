// Act 5 — 结果 / bearing fruit. The light carried into the crown sets it
// blooming; three fruits ripen, one above each cat on the limb, each on a
// downbeat: 放得下 (Maine Coon), 越来越懂 (Ragdoll), 不再从零开始 (Siamese).
// The camera then pulls back to the whole glowing tree, heavy with fruit.

import { place, poseAt } from './cast.js';
import { limbTop } from './act4.js';
import { buildTree, evaluate } from '../tree.js';
import { breathe, pop, CAT_GLOW } from '../scene/cats.js';
import { K, burst, ripples } from '../scene/particles.js';
import { ramp, ease, smoothstep, lerp, clamp, envelope, spring, rng } from '../util.js';

const E = ease;
export const STATION = { siamese: 6.4, ragdoll: 11.9, maine: 16.9 };
export const FRUITS = [
  { cat: 'maine', at: 78.0, dx: -1.15, side: -1 },
  { cat: 'ragdoll', at: 84.0, dx: -1.1, side: -1 },
  { cat: 'siamese', at: 90.0, dx: 1.05, side: 1 },
];

// each fruit grows on a twig that sprouts from the limb beside its cat
function twigFor(f) {
  const base = limbTop(STATION[f.cat] + f.dx);
  const pts = [];
  for (let i = 0; i <= 24; i++) {
    const u = i / 24;
    // up, then arching over so the fruit hangs clear of the limb
    const x = base[0] + Math.sin(u * 2.4) * 0.75 * f.side;
    const y = base[1] - 0.1 + Math.sin(u * 2.2) * 2.3;
    pts.push([x, y]);
  }
  return buildTree({ seed: 50 + Math.round(f.at), kind: 'crown', start: pts, phases: [], rTip: 0.035, pipeK: 0.28, pipeExp: 0.5 });
}
for (const f of [
  { cat: 'maine' },
  { cat: 'ragdoll' },
  { cat: 'siamese' },
]) void f;

export function fruitAnchor(f) {
  if (!f.twig) f.twig = twigFor(f);
  const tw = f.twig;
  const i = tw.n - 1;
  return { x: tw.X[i], top: tw.Y[i], y: tw.Y[i] - 0.55 };
}

/** 0..1 ripeness and swell for a hero fruit. */
function ripe(f, t) {
  const grow = ramp(t, f.at - 1.6, f.at, E.inOutSine);
  const pop2 = spring(t, f.at, 2.2, 5.5);
  return { grow, size: 0.1 + 0.26 * grow * (t > f.at ? clamp(pop2, 0, 1.25) : 1), light: smoothstep(f.at - 0.2, f.at + 0.35, t) };
}

export function act5(S, t, ctx) {
  if (t < 74.5 || t > 122) return;
  const L = S.light;
  const P = S.parts.mid;
  const bottom = ctx.canopyBottom;

  // ---- hero fruits on their twigs
  for (const f of FRUITS) {
    if (t < f.at - 3.2) continue;
    const a = fruitAnchor(f);
    const tw = f.twig;
    const grow = ramp(t, f.at - 3.2, f.at - 1.4, E.outCubic);
    evaluate(tw, tw.maxD * grow + 0.01, 1);
    S.crowns.push({ tree: tw, bark: [0.1, 0.075, 0.05], barkDark: [0.04, 0.03, 0.02], barkLit: [0.2, 0.15, 0.1], young: 1 });
    if (grow < 1) {
      const k = Math.min(tw.n - 1, Math.floor(grow * (tw.n - 1)));
      P.push(tw.X[k], tw.Y[k], 0.04, 0.06, 1.2, 1.4, 0.8, 1, 0, K.glow);
    }
    // two leaves along the twig
    for (const [u, side] of [[0.45, 1], [0.75, -1]]) {
      const k = Math.floor(u * (tw.n - 1));
      const on = smoothstep(u, u + 0.2, grow);
      P.push(tw.X[k] + 0.14 * side, tw.Y[k] + 0.05, 0.05, 0.2 * on, 0.14, 0.36, 0.2, on, -0.9 * side, K.leaf, 1, 0.5);
    }
    if (t < f.at - 1.8) continue;
    const r = ripe(f, t);
    const falls = f.cat === 'siamese' && t > 96.0;
    if (falls) continue; // act 6 takes this one
    const sway = Math.sin(t * 1.1 + a.x) * 0.04;
    const fy = a.top - 0.12 - r.size;
    const fx = a.x + sway;
    S.ribbons.push({ pts: [[a.x, a.top, 1, 1], [fx, fy + r.size * 0.9, 0.7, 1]], width: 0.022, color: [0.03, 0.05, 0.03, 1], core: 1, alpha: 1, premul: true });
    const col = CAT_GLOW[f.cat];
    P.push(fx, fy, 0.04, r.size, col[0] * 0.8, col[1] * 0.8, col[2] * 0.8, smoothstep(0, 0.2, r.grow), 0, K.fruit, 1, r.light);
    // a small leaf on the stem
    if (t > f.at) {
      ripples(P, t, f.at, { x: fx, y: fy, count: 2, gap: 0.35, speed: 1.1, life: 1.4, col: col.map((v) => v * 0.6), aspect: 1, size0: 0.55 });
      burst(P, t, f.at, { x: fx, y: fy, n: 36, speed: 2.2, life: 1.8, size: 0.06, col: col.map((v) => v * 1.3), gravity: -0.4, seed: Math.round(f.at), spread: 6.3 });
    }
    S.ground.glows.push({ x: fx, y: fy, r: 3, i: 0.6 * r.light, col });
  }

  // ---- a crown heavy with smaller fruit, lighting in a wave on the pull-back
  const fr = ctx.smallFruits;
  for (const s of fr) {
    const on = ramp(t, s.at, s.at + 0.5, E.outBack);
    if (on <= 0) continue;
    const sw = Math.sin(t * 1.2 + s.x) * 0.04;
    S.ribbons.push({ pts: [[s.x, s.top, 1, 1], [s.x + sw, s.y + s.r * 0.9, 0.7, 1]], width: 0.022, color: [0.03, 0.05, 0.03, 1], core: 1, alpha: on, premul: true });
    P.push(s.x + sw, s.y, 0.03, s.r * on, s.col[0], s.col[1], s.col[2], on, 0, K.fruit, 1, 0.8);
  }

  // ---- the cats on the limb (act 4 hands them over at 75)
  if (t > 75.0 && t < 96.0) {
    const seq = {
      maine: [[75, 'sit'], [76.4, 'look-up'], [78.05, 'reach'], [79.3, 'look-up'], [80.4, 'sit'], [83, 'loaf']],
      ragdoll: [[75, 'look-up'], [79, 'sit'], [82.4, 'look-up'], [84.05, 'reach'], [85.4, 'present'], [86.6, 'tail-up'], [88, 'loaf']],
      siamese: [[75, 'look-up'], [80, 'sit'], [88.3, 'look-up'], [89.7, 'crouch'], [90.05, 'jump'], [90.8, 'land'], [91.4, 'sit'], [93.5, 'look-up']],
    };
    for (const cat of ['siamese', 'ragdoll', 'maine']) {
      const p = poseAt(seq[cat], t);
      const top = limbTop(STATION[cat]);
      let y = top[1];
      if (cat === 'siamese' && t > 90.05 && t < 90.8) y += 1.1 * Math.sin(Math.PI * (t - 90.05) / 0.75);
      const b = breathe(t, top[0]);
      const q = pop(t, p.since, 0.07);
      const f = FRUITS.find((x) => x.cat === cat);
      const a = fruitAnchor(f);
      const lit = ripe(f, t).light;
      place(ctx, S, cat, p.pose, top[0], {
        y,
        flip: cat !== 'maine',
        squash: [b[0] * q[0], b[1] * q[1]],
        ambient: L.catAmbient,
        keyCol: L.catKey,
        glowRim: 0.1 * lit,
        pts: [{ x: a.x, y: a.y, r: 2.2, i: 1.1 * lit, col: CAT_GLOW[cat] }],
      });
    }
  }
}

/** Positions for the crown's smaller fruit, computed once from the canopy. */
export function smallFruitLayout(canopyBottom) {
  const r = rng(77);
  const cols = [CAT_GLOW.ragdoll, CAT_GLOW.maine, CAT_GLOW.siamese, [1.6, 0.7, 0.9], [1.5, 1.2, 0.6]];
  const out = [];
  for (let i = 0; i < 46; i++) {
    const x = r.range(-50, 50);
    if (x > 3 && x < 20) continue; // keep the hero fruit clear
    const top = canopyBottom(x) + 0.2 + r.range(-0.5, 2.5);
    const drop = r.range(0.4, 1.4);
    const at = 93.0 + Math.abs(x) / 50 * 2.2 + r.range(0, 0.4);
    out.push({ x, top, y: top - drop, r: r.range(0.28, 0.5), col: cols[i % cols.length].map((v) => v * 0.75), at });
  }
  return out;
}
