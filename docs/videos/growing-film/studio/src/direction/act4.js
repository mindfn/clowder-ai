// Act 4 — 托付 / entrusting. Dusk. The person sets down a lantern and walks
// away. The cats relay a light along a low limb hung with lanterns (promises).
// Maine Coon reaches for the prop root that holds up its own limb: the
// dependency chain lights, the lanterns it would take down dim one by one; the
// paw stops; a new tendril from the shared roots offers another way; the
// lanterns relight and the light is carried up into the crown.

import { place, poseAt } from './cast.js';
import { rig, POSES, blendPose, gait } from '../scene/human.js';
import { hill } from '../scene/world.js';
import { buildTree, evaluate } from '../tree.js';
import { breathe, pop, CAT_GLOW } from '../scene/cats.js';
import { K, burst, motes, fireflies } from '../scene/particles.js';
import { ramp, ease, smoothstep, lerp, clamp, envelope, qbez, noise1, spring } from '../util.js';
import { crownScale } from './tree.js';

const E = ease;

function chain(points, opts = {}) {
  const t = buildTree({ seed: opts.seed ?? 3, kind: 'crown', start: points, phases: [], rTip: opts.rTip ?? 0.05, pipeK: opts.pipeK ?? 2.0, pipeExp: 0.5 });
  return t;
}

// the stage limb: out of the trunk to the right, below the crown
const LIMB_PTS = [];
for (let i = 0; i <= 56; i++) {
  const u = i / 56;
  const x = 1.6 + u * 21.5;
  const y = 10.8 + 2.2 * Math.sqrt(u) + u * 2.6 - Math.sin(u * Math.PI) * 1.2 + Math.sin(u * 9.0) * 0.22 + Math.sin(u * 23.0) * 0.06;
  LIMB_PTS.push([x, y]);
}
export const LIMB = chain(LIMB_PTS, { seed: 21, pipeK: 1.75, rTip: 0.16 });

/** Point on the limb's upper surface at world x (full-grown tree). */
export function limbTop(x) {
  evaluate(LIMB, 999, 1);
  let best = 0;
  for (let i = 0; i < LIMB.n; i++) if (Math.abs(LIMB.X[i] - x) < Math.abs(LIMB.X[best] - x)) best = i;
  const i0 = Math.max(0, Math.min(LIMB.n - 2, best));
  return [LIMB.X[i0], LIMB.Y[i0] + LIMB.rad[i0] * 0.92, LIMB.rad[i0]];
}

const PROP_X = 17.6;
const PROP = (() => {
  const top = limbTop(PROP_X);
  const pts = [];
  const g = hill(PROP_X + 0.3);
  for (let i = 0; i <= 40; i++) {
    const u = i / 40;
    pts.push([PROP_X + Math.sin(u * 7 + 1) * 0.3 * Math.sin(u * Math.PI) + u * 0.45, lerp(top[1] - top[2] * 0.6, g - 0.3, u)]);
  }
  return chain(pts, { seed: 33, pipeK: 0.35, rTip: 0.2 });
})();

const VINE_X = 20.2;
const VINE = (() => {
  const top = limbTop(VINE_X - 0.6);
  const g = hill(VINE_X);
  const pts = [];
  for (let i = 0; i <= 60; i++) {
    const u = i / 60;
    const y = lerp(g - 0.3, top[1] - 0.2, u);
    pts.push([VINE_X + Math.sin(u * 14) * 0.35 * (1 - u * 0.5) - u * 0.6, y]);
  }
  return chain(pts, { seed: 44, pipeK: 0.3, rTip: 0.06 });
})();

export const LANTERN_X = [8.8, 11.2, 13.6, 15.4, 18.9, 21.0];
const LANTERN_DROP = [1.5, 1.1, 1.8, 1.2, 1.6, 1.0];
// relay stations on the limb
const STATION = { siamese: 6.4, ragdoll: 11.9, maine: 16.9 };

function orbPos(t) {
  const a = limbTop(STATION.siamese);
  const b = limbTop(STATION.ragdoll);
  const c = limbTop(STATION.maine);
  const hold = (p, dy = 0.62) => [p[0] - 0.5, p[1] + dy];
  if (t < 61.5) return hold(a);
  if (t < 62.2) return qbez(hold(a), [(a[0] + b[0]) / 2, a[1] + 3.2], hold(b), E.inOutSine((t - 61.5) / 0.7));
  if (t < 63.0) return hold(b);
  if (t < 63.7) return qbez(hold(b), [(b[0] + c[0]) / 2, b[1] + 3.0], hold(c), E.inOutSine((t - 63.0) / 0.7));
  if (t < 73.5) return hold(c, 0.62);
  const u = E.inOutSine(clamp((t - 73.5) / 1.3));
  return qbez(hold(c, 0.62), [c[0] - 2, c[1] + 9], [8, 27], u);
}

export function lanternLight(k, t) {
  const on = ramp(t, 60.0 + k * 0.4, 60.35 + k * 0.4, E.outCubic);
  // the preview: outermost promises dim first, one per beat
  const order = LANTERN_X.length - 1 - k;
  const dimAt = 66.0 + order * 0.75 * (order < 4 ? 1 : 0.5);
  const dim = k >= 2 ? ramp(t, dimAt, dimAt + 0.45, E.inOutSine) : 0;
  const re = ramp(t, 71.25 + (k - 2) * 0.35, 71.6 + (k - 2) * 0.35, E.outBack);
  return on * (1 - dim * (1 - re) * 0.9);
}

export function act4(S, t, ctx) {
  if (t < 44.0 || t > 122.5) return;
  const L = S.light;
  const P = S.parts.mid;
  const sc = crownScale(t);
  const grow = smoothstep(44, 53, t);

  // ---- the stage limb, grown with the tree
  evaluate(LIMB, 22 * grow + 0.01, 1);
  const warn = envelope(t, 65.1, 65.7, 70.8, 71.8);
  S.crowns.unshift({
    tree: LIMB,
    scale: sc,
    bark: [0.13, 0.085, 0.06],
    barkDark: [0.045, 0.032, 0.026],
    barkLit: [0.27, 0.19, 0.13],
    glowA: [1.8, 0.16, 0.08],
    glowB: [1.6, 0.22, 0.08],
    glowC: [1.8, 0.16, 0.08],
    glow: (p) => (p[0] > PROP_X * sc - 0.5 ? warn * 0.35 : 0),
    flow: 5,
  });
  if (t < 54) return;

  // ---- the prop root (a dependency) and the offered tendril
  evaluate(PROP, 99, 1);
  S.crowns.push({
    tree: PROP,
    bark: [0.1, 0.07, 0.05],
    barkDark: [0.035, 0.025, 0.02],
    barkLit: [0.2, 0.14, 0.1],
    glowA: [2.0, 0.14, 0.06],
    glowB: [1.8, 0.2, 0.06],
    glowC: [2.0, 0.14, 0.06],
    glow: () => warn * (0.7 + 0.3 * Math.sin(t * 9)),
    flow: 7,
  });
  const vineF = ramp(t, 70.5, 71.6, E.outCubic) * VINE.maxD;
  if (vineF > 0) {
    evaluate(VINE, vineF, 1);
    S.crowns.push({
      tree: VINE,
      bark: [0.05, 0.1, 0.05],
      barkDark: [0.02, 0.045, 0.025],
      barkLit: [0.12, 0.2, 0.1],
      glowA: CAT_GLOW.ragdoll,
      glowB: CAT_GLOW.maine,
      glowC: CAT_GLOW.siamese,
      braid: 1,
      glow: () => 0.9,
      flow: 6,
    });
    const tipU = vineF / VINE.maxD;
    if (tipU < 1) {
      const i = Math.min(VINE.n - 1, Math.floor(tipU * (VINE.n - 1)));
      P.push(VINE.X[i], VINE.Y[i], 0.05, 0.12, 1.4, 1.5, 1.2, 1.2, 0, K.glow);
    }
  }
  burst(P, t, 71.55, { x: VINE_X - 0.6, y: limbTop(VINE_X - 0.6)[1], n: 30, speed: 2, life: 1.2, size: 0.06, col: [1.2, 1.6, 1.4], seed: 88 });

  // ---- lanterns (promises)
  LANTERN_X.forEach((lx, k) => {
    const top = limbTop(lx);
    const drop = LANTERN_DROP[k];
    const sw = Math.sin(t * 1.3 + k) * 0.06;
    const ly = top[1] - top[2] * 1.4 - drop;
    const lxx = lx + sw * drop;
    const light = lanternLight(k, t);
    S.ribbons.push({ pts: [[lx, top[1] - top[2] * 1.2, 1, 1], [lxx, ly + 0.36, 1, 1]], width: 0.018, color: [0.02, 0.015, 0.012, 1], core: 1, alpha: 1, premul: true });
    P.push(lxx, ly, 0.02, 0.36, 1.5, 0.75, 0.3, 1, sw * 0.4, K.lantern, 1, light);
    if (light > 0.02) P.push(lxx, ly, 0.03, 0.55, 1.2, 0.6, 0.22, 0.5 * light, 0, K.glow);
    // the chain: dependency threads from the prop root to each promise it holds up
    if (k >= 2 && warn > 0.01) {
      const a = [PROP_X, limbTop(PROP_X)[1] - 0.3];
      const b = [lxx, ly + 0.3];
      const mid = [(a[0] + b[0]) / 2, Math.min(a[1], b[1]) - 1.2];
      const pts = [];
      for (let q = 0; q <= 16; q++) {
        const u = q / 16;
        const p = qbez(a, mid, b, u);
        pts.push([p[0], p[1], 1, 1]);
      }
      S.ribbons.push({ pts, width: 0.035, color: [1.8, 0.16, 0.06, 1], core: 1.0, alpha: warn * 0.7, pulseFreq: 6, pulseSpeed: 14, pulseAmt: 2.5 });
    }
  });

  // ---- the person leaves
  if (t < 61) {
    const lanternX = 6.2;
    let x = 7.0;
    let facing = -1;
    let pose = POSES.stand;
    if (t < 54.75) pose = POSES.stand;
    else if (t < 55.7) pose = blendPose(POSES.stand, POSES.bend, envelope(t, 54.75, 55.1, 55.35, 55.7));
    else if (t < 56.25) pose = blendPose(POSES.stand, POSES.lookUp, ramp(t, 55.7, 56.0));
    else {
      facing = 1;
      const d = Math.max(0, t - 56.4) * 2.3;
      x = 7.0 + d;
      pose = gait(POSES.stand, d * 2.8, 1.0);
      if (t < 56.4) pose = blendPose(POSES.lookUp, POSES.stand, ramp(t, 56.25, 56.4));
    }
    const r = rig(pose, x, hill(x), { facing, t, scale: 0.86, wind: 0.6 });
    S.humans.push({ ...r, body: [0.01, 0.009, 0.012], rimCol: L.rimCol, pt: { x: lanternX, y: hill(lanternX) + 0.5, r: 2.2, i: t > 55.0 ? 1.2 : 0, col: [1.5, 0.75, 0.3] } });
    ctx._personX = x;
  }
  // the lantern left at the foot of the tree
  if (t > 54.95) {
    const lx = 6.2;
    const ly = hill(lx) + 0.36;
    P.push(lx, ly, 0.02, 0.3, 1.5, 0.75, 0.3, 1, 0, K.lantern, 1, ramp(t, 55.0, 55.4));
    P.push(lx, ly, 0.03, 0.6, 1.2, 0.6, 0.22, 0.6 * ramp(t, 55.0, 55.4), 0, K.glow);
    S.ground.glows.push({ x: lx, y: ly, r: 2.4, i: 1.1 * ramp(t, 55.0, 55.6), col: [1.4, 0.7, 0.3] });
  }

  // ---- the cats on the limb (act 5 takes over at 75)
  if (t < 75.0) {
  const seq = {
    siamese: [[54, 'look-down'], [58.2, 'sit'], [60.0, 'present'], [61.6, 'tail-up'], [63.2, 'sit'], [65.4, 'alert'], [69.5, 'look-up']],
    ragdoll: [[54, 'look-down'], [57.0, 'wave'], [58.6, 'sit'], [61.9, 'reach'], [62.3, 'present'], [63.1, 'tail-up'], [65.4, 'alert'], [69.5, 'look-up']],
    maine: [[54, 'look-down'], [58.4, 'loaf'], [63.4, 'reach'], [63.8, 'present'], [64.5, 'look-down'], [65.0, 'flatten'], [69.0, 'alert'], [69.6, 'think'], [70.9, 'look-down'], [71.8, 'sit'], [73.0, 'present'], [74.6, 'look-up']],
  };
  for (const cat of ['siamese', 'ragdoll', 'maine']) {
    const p = poseAt(seq[cat], t);
    const top = limbTop(STATION[cat]);
    const b = breathe(t, top[0]);
    // freeze: at the paw-stop the Maine Coon holds perfectly still
    const still = cat === 'maine' && t > 69.0 && t < 69.6;
    const q = still ? [1, 1] : pop(t, p.since, 0.07);
    place(ctx, S, cat, p.pose, top[0], { y: top[1], flip: cat !== 'maine' ? true : false, squash: still ? [1, 1] : [b[0] * q[0], b[1] * q[1]], ambient: L.catAmbient, keyCol: L.catKey, pts: [{ x: orbPos(t)[0], y: orbPos(t)[1], r: 1.6, i: t > 59.8 && t < 75 ? 0.6 : 0, col: [1.3, 1.2, 0.9] }] });
  }
  }

  // ---- the orb being relayed, then carried up into the crown
  if (t > 59.8 && t < 75.2) {
    const o = orbPos(t);
    const a = ramp(t, 59.8, 60.3) * (1 - ramp(t, 74.6, 75.2));
    P.push(o[0], o[1], 0.05, 0.1, 1.8, 1.7, 1.3, a * 1.3, 0, K.glow);
    P.push(o[0], o[1], 0.05, 0.24, 1.6, 1.4, 1.0, a * 0.4, t * 1.5, K.sparkle);
    const moving = (t > 61.5 && t < 62.2) || (t > 63.0 && t < 63.7) || t > 73.5;
    if (moving) {
      const pts = [];
      for (let k = 0; k <= 14; k++) {
        const o2 = orbPos(t - k * 0.025);
        pts.push([o2[0], o2[1], 1 - k / 14, 1 - k / 14]);
      }
      pts.reverse();
      S.ribbons.push({ pts, width: 0.06, color: [1.4, 1.3, 1.0, 1], core: 1.4, alpha: a });
    }
  }
  burst(P, t, 74.8, { x: 8, y: 27, n: 80, speed: 6, life: 2.4, size: 0.1, col: [2.0, 1.6, 1.0], gravity: -0.5, spread: 6.3, seed: 91 });
  // fireflies come out as the dusk deepens
  fireflies(P, t, { n: 40, x0: 2, x1: 26, y0: 1, y1: 14, size: 0.06, alpha: smoothstep(62, 70, t), seed: 12 });
}
