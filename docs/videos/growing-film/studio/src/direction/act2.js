// Act 2 — 疯长 / the rush. Days flicker past while the tree shoots up; then each
// cat sits in its own glass case and the person runs between them carrying
// notes (paper planes) until the glass cracks. Ends with the shatter (act 3).

import { place, poseAt } from './cast.js';
import { rig, POSES, blendPose, gait } from '../scene/human.js';
import { hill } from '../scene/world.js';
import { makeShards, emitShards } from '../scene/glass.js';
import { breathe, pop } from '../scene/cats.js';
import { K, burst } from '../scene/particles.js';
import { ramp, ease, smoothstep, lerp, clamp, qbez, qbezTan, keys, noise1 } from '../util.js';

const E = ease;
const HW = 1.05;
const HH = 1.2;
export const BOX_X = { siamese: -7.0, ragdoll: -3.6, maine: 4.4 };
export const boxOf = (cat) => {
  const x = BOX_X[cat];
  return [x, hill(x) + HH + 0.02, HW, HH];
};

// person's route through the glass scene: [t0, t1, x0, x1, mode, target]
export const ROUTE = [
  [24.0, 24.6, 2.6, 2.6, 'stand'],
  [24.6, 25.2, 2.6, 2.6, 'throw', 'maine'],
  [25.2, 26.3, 2.6, 2.6, 'lookUp'],
  [26.3, 27.2, 2.6, -1.9, 'run'],
  [27.2, 27.8, -1.9, -1.9, 'throw', 'ragdoll'],
  [27.8, 28.5, -1.9, -1.9, 'lookUp'],
  [28.5, 29.1, -1.9, -5.3, 'run'],
  [29.1, 29.7, -5.3, -5.3, 'throw', 'siamese'],
  [29.7, 30.3, -5.3, -5.3, 'knock'],
  [30.3, 31.2, -5.3, 2.4, 'run'],
  [31.2, 31.7, 2.4, 2.4, 'throw', 'maine'],
  [31.7, 32.3, 2.4, -1.9, 'run'],
  [32.3, 32.8, -1.9, -1.9, 'throw', 'ragdoll'],
  [32.8, 33.5, -1.9, 0.6, 'run'],
  [33.5, 37.0, 0.6, 0.6, 'tired'],
];

function personAt(t) {
  let seg = ROUTE[0];
  for (const s of ROUTE) if (t >= s[0]) seg = s;
  const [t0, t1, x0, x1, mode, target] = seg;
  const u = clamp((t - t0) / (t1 - t0));
  const x = mode === 'run' ? lerp(x0, x1, E.inOutSine(u)) : x0;
  // face the direction of travel, or the case being served
  let facing = 1;
  if (mode === 'run') facing = x1 < x0 ? -1 : 1;
  else if (target) facing = BOX_X[target] < x ? -1 : 1;
  else if (mode === 'knock') facing = -1;
  else facing = x > 0 ? -1 : 1;
  let pose;
  if (mode === 'run') {
    const dist = Math.abs(x1 - x0) * E.inOutSine(u);
    pose = gait(POSES.stand, dist * 2.6, 1.7);
  } else if (mode === 'throw') {
    const k = ramp(t, t0, t0 + 0.18, E.outCubic) * (1 - ramp(t, t0 + 0.2, t0 + 0.42, E.inOutSine));
    pose = blendPose(blendPose(POSES.stand, POSES.throw, k), POSES.throwDone, ramp(t, t0 + 0.2, t0 + 0.4) * (1 - ramp(t, t0 + 0.45, t1)));
  } else if (mode === 'knock') {
    const k = 0.5 + 0.5 * Math.sin((t - t0) * 22);
    pose = blendPose(POSES.stand, { ...POSES.throwDone, shN: 1.5 + 0.25 * k, elN: 0.3, head: 0.1 }, ramp(t, t0, t0 + 0.12));
  } else if (mode === 'tired') {
    pose = blendPose(POSES.stand, POSES.tired, ramp(t, t0, t0 + 0.8, E.outCubic));
    pose = { ...pose, pelvisY: pose.pelvisY - 0.04 * Math.sin((t - t0) * 2.5) };
  } else if (mode === 'lookUp') {
    pose = blendPose(POSES.stand, POSES.lookUp, ramp(t, t0, t0 + 0.4));
  } else pose = POSES.stand;
  return { x, facing, pose, mode, t0 };
}

// paper planes: [start, end, from, to, arc]; endpoints resolved at runtime
export const FLIGHTS = [
  [24.75, 25.55, 'person', 'maine', 2.2],
  [25.95, 26.65, 'maine', 'person', 1.6],
  [27.3, 27.85, 'person', 'ragdoll', 1.6],
  [28.05, 28.65, 'ragdoll', 'person', 1.4],
  [29.25, 29.85, 'person', 'siamese', 1.8],
  [30.05, 30.75, 'siamese', 'person', 2.2],
  [31.3, 31.85, 'person', 'maine', 2.0],
  [31.95, 32.6, 'maine', 'person', 1.8],
  [32.4, 32.95, 'person', 'ragdoll', 1.5],
  [33.0, 33.7, 'ragdoll', 'person', 1.7],
  [33.3, 34.1, 'siamese', 'person', 2.6],
  [33.6, 34.3, 'maine', 'person', 2.0],
  [33.9, 34.7, 'ragdoll', 'person', 2.4],
  [34.2, 34.9, 'siamese', 'person', 1.6],
  [34.4, 35.1, 'maine', 'person', 2.8],
];

function slot(cat) {
  const b = boxOf(cat);
  return [b[0], b[1] + b[3] + 0.08];
}

function glassState(cat, t, i) {
  const b = boxOf(cat);
  const appear = ramp(t, 24.05 + i * 0.18, 24.75 + i * 0.18, E.outCubic);
  const fog = smoothstep(30, 35.2, t) * 0.85;
  const crack = t > 35.25 ? lerp(0, 2.2, ramp(t, 35.25 + i * 0.06, 35.8 + i * 0.06, E.outExpo)) : 0;
  const flash = t > 35.9 && t < 36.0 ? ramp(t, 35.9, 36.0) : 0;
  return {
    box: b,
    appear,
    fog,
    crack,
    impact: [b[0] + (i - 1) * 0.25, b[1] + b[3] * 0.55],
    alpha: t < 36.0 ? 1 : 0,
    flash,
    seed: i * 3.7 + 1,
  };
}

let SHARDS = null;
function shards() {
  if (!SHARDS) {
    SHARDS = ['siamese', 'ragdoll', 'maine'].map((cat, i) => {
      const b = boxOf(cat);
      return { cat, b, list: makeShards(b, 34, 101 + i * 17, [(i - 1) * 0.25, HH * 0.55]) };
    });
  }
  return SHARDS;
}

/** Slow motion for the first beats after the break. */
export function shatterTime(t) {
  const d = t - 36.0;
  if (d < 1.3) return d * 0.32;
  return 0.416 + (d - 1.3) * 1.05;
}

export function act2(S, t, ctx) {
  if (t < 17.8 || t > 41) return;
  const P = S.parts.mid;
  // ------------- time-lapse days (18 – 24)
  if (t < 24.0) {
    const L = S.light;
    const day = [
      { siamese: ['sit', -5.2, true], ragdoll: ['sit', -2.9, true], maine: ['loaf', 3.4, false] },
      { siamese: ['read', -5.0, true], ragdoll: ['look-up', -3.0, true], maine: ['groom', 3.3, false] },
      { siamese: ['walk-2', -4.2, true], ragdoll: ['jump', -2.4, true, 1.3], maine: ['sleep', 3.6, false] },
      { siamese: ['sit', -3.9, true], ragdoll: ['stretch', -3.3, true], maine: ['look-up', 3.2, false] },
    ];
    const k = Math.min(3, Math.floor((t - 18.0) / 1.5));
    const since = 18.0 + k * 1.5;
    for (const cat of ['siamese', 'ragdoll', 'maine']) {
      const [pose, x, flip, lift] = day[Math.max(0, k)][cat];
      const q = pop(t, since, 0.09);
      place(ctx, S, cat, pose, x, { flip, y: hill(x) + (lift ?? 0), squash: q, ambient: L.catAmbient, keyCol: L.catKey });
    }
    const pk = Math.max(0, k);
    const pose = [POSES.stand, POSES.lookUp, POSES.sit, POSES.lookUp][pk];
    const px = [5.6, 5.4, 5.9, 5.2][pk];
    const r = rig(t < 18.5 ? blendPose(POSES.kneel, POSES.stand, ramp(t, 17.8, 18.5)) : pose, px, hill(px), { facing: -1, t, scale: 0.86 });
    S.humans.push({ ...r, body: [0.01, 0.011, 0.016], rimCol: L.rimCol });
    return;
  }

  // ------------- glass scene (24 – 36) and the shatter
  const L = S.light;
  const names = ['siamese', 'ragdoll', 'maine'];
  const seqs = {
    siamese: [[24, 'read'], [29.85, 'alert'], [30.05, 'carry'], [30.8, 'read'], [33.2, 'paw'], [34.0, 'alert'], [36.0, 'startle'], [36.9, 'alert'], [37.8, 'look-up']],
    ragdoll: [[24, 'work'], [27.85, 'alert'], [28.05, 'carry'], [28.7, 'work'], [32.95, 'alert'], [33.0, 'carry'], [33.8, 'think'], [34.6, 'look-up'], [36.0, 'startle'], [36.9, 'alert'], [37.8, 'look-up']],
    maine: [[24, 'think'], [25.55, 'alert'], [25.75, 'carry'], [26.7, 'work'], [31.85, 'alert'], [32.0, 'carry'], [32.7, 'think'], [34.2, 'yawn'], [36.0, 'startle'], [36.9, 'alert'], [37.8, 'look-up']],
  };
  if (t < 40.5) names.forEach((cat, i) => {
    const p = poseAt(seqs[cat], t);
    const b = breathe(t, i * 1.7);
    const q = pop(t, p.since, 0.08);
    let x = BOX_X[cat];
    // the jolt of the break
    let y = hill(x);
    if (t > 36.0 && t < 36.9) y += 0.35 * Math.sin(Math.PI * clamp((t - 36.0) / 0.6));
    const flip = cat === 'maine' ? (p.pose === 'paw' ? false : false) : true;
    place(ctx, S, cat, p.pose, x, { flip, y, squash: [b[0] * q[0], b[1] * q[1]], ambient: L.catAmbient, keyCol: L.catKey });
  });
  if (t < 36.0) names.forEach((cat, i) => S.glass.push(glassState(cat, t, i)));

  // the person
  if (t < 36.0) {
    const per = personAt(t);
    const r = rig(per.pose, per.x, hill(per.x), { facing: per.facing, t, scale: 0.86 });
    S.humans.push({ ...r, body: [0.012, 0.012, 0.016], rimCol: L.rimCol });
  }

  // paper planes
  for (const [t0, t1, from, to, arc] of FLIGHTS) {
    if (t < t0 || t > t1 + 0.25) continue;
    const u = clamp((t - t0) / (t1 - t0));
    const a = from === 'person' ? handAt(t0) : slot(from);
    const b = to === 'person' ? handAt(t1) : slot(to);
    const c = [(a[0] + b[0]) / 2, Math.max(a[1], b[1]) + arc];
    const eu = E.inOutSine(u);
    const p = qbez(a, c, b, eu);
    const tg = qbezTan(a, c, b, eu);
    const ang = Math.atan2(tg[1], tg[0]);
    const bank = Math.sin(u * Math.PI) * 0.8;
    const alpha = smoothstep(0, 0.06, u) * (1 - smoothstep(0.93, 1.0, u));
    P.push(p[0], p[1], 0.3, 0.26, 1.3, 1.25, 1.15, alpha, ang, K.plane, 1, bank);
    // a faint wake
    const pts = [];
    for (let k = 0; k <= 10; k++) {
      const uu = Math.max(0, eu - k * 0.025);
      const q2 = qbez(a, c, b, uu);
      pts.push([q2[0], q2[1], 1 - k / 10, 1 - k / 10]);
    }
    pts.reverse();
    S.ribbons.push({ pts, width: 0.03, color: [0.5, 0.55, 0.6, 1], core: 0.8, alpha: alpha * 0.6, z: 0.28 });
    if (to !== 'person') burst(P, t, t1, { x: b[0], y: b[1], n: 10, speed: 1.2, life: 0.6, size: 0.05, col: [1.6, 1.6, 1.4], seed: Math.floor(t0 * 10) });
  }
  // the knock: ripples on the case
  if (t > 29.7 && t < 30.4) {
    const b = boxOf('siamese');
    for (let k = 0; k < 4; k++) {
      const tk = 29.75 + k * 0.14;
      if (t > tk && t < tk + 0.5) P.push(b[0] + b[2] - 0.05, b[1] + 0.3, 0.2, 0.1 + (t - tk) * 1.6, 0.8, 0.9, 1.0, 0.8 * (1 - (t - tk) / 0.5), Math.PI / 2, K.ring, 0.35);
    }
  }

  // the shatter
  if (t >= 36.0 && t < 40.5) {
    const tau = shatterTime(t);
    const fade = 1 - smoothstep(38.5, 40.2, t);
    for (const sh of shards()) emitShards(ctx._shardW, ctx._shardWFg, sh.list, sh.b, tau, { fade, gravity: -7 });
    for (const [i, cat] of names.entries()) {
      const b = boxOf(cat);
      burst(P, t, 36.0, { x: b[0], y: b[1] + 0.4, n: 40, speed: 5.5, life: 1.8, size: 0.06, col: [1.8, 1.9, 2.1], gravity: -2, seed: 70 + i, spread: 6.3 });
    }
  }
}

function handAt(t) {
  const per = personAt(t);
  const r = rig(per.pose, per.x, hill(per.x), { facing: per.facing, t, scale: 0.86 });
  return r.hand;
}
