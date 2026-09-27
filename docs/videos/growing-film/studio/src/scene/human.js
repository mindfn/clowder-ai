// The person: a side-view silhouette rig evaluated to uneven capsules for the
// SDF shader. Poses are joint angles, so any two poses blend by interpolation.
//
// Angles (radians, facing +x): lean = torso tilt forward; arms/legs measured
// from hanging straight down, positive = swung forward. Elbows bend forward
// (added), knees bend backward (subtracted).

import { lerp } from '../util.js';

const DIM = {
  thigh: 1.2,
  shin: 1.15,
  torso: 1.55,
  neck: 0.3,
  upper: 0.82,
  fore: 0.78,
  foot: 0.34,
  head: 0.29,
};

const BASE = {
  pelvisY: 2.46,
  lean: 0.03,
  head: 0.0, // head tilt (+ = look up)
  shN: 0.1, elN: 0.18, shF: -0.08, elF: 0.2, // near / far arm
  hipN: 0.02, knN: 0.03, hipF: -0.02, knF: 0.03,
  scarf: 0.0,
};

export const POSES = {
  stand: { ...BASE },
  kneel: { ...BASE, pelvisY: 1.42, lean: 0.22, head: -0.25, shN: 0.2, elN: 0.7, shF: 0.1, elF: 0.5, hipN: 1.45, knN: 1.5, hipF: 0.12, knF: 1.66 },
  kneelPress: { ...BASE, pelvisY: 1.38, lean: 0.62, head: -0.5, shN: 0.35, elN: 0.2, shF: 0.3, elF: 0.25, hipN: 1.5, knN: 1.55, hipF: 0.14, knF: 1.66 },
  crouchLook: { ...BASE, pelvisY: 1.42, lean: 0.32, head: -0.5, shN: 0.3, elN: 0.8, shF: 0.15, elF: 0.6, hipN: 1.45, knN: 1.5, hipF: 0.12, knF: 1.66 },
  kneelUp: { ...BASE, pelvisY: 1.42, lean: 0.05, head: 0.55, shN: 0.35, elN: 1.9, shF: 0.1, elF: 0.4, hipN: 1.45, knN: 1.5, hipF: 0.12, knF: 1.66 },
  throw: { ...BASE, lean: -0.08, head: 0.35, shN: 2.5, elN: 0.25, shF: -0.35, elF: 0.3, hipN: 0.3, knN: 0.1, hipF: -0.25, knF: 0.2 },
  throwDone: { ...BASE, lean: 0.22, head: 0.2, shN: 1.2, elN: 0.05, shF: -0.5, elF: 0.3, hipN: 0.35, knN: 0.15, hipF: -0.3, knF: 0.35 },
  lookUp: { ...BASE, head: 0.55, lean: -0.06, shN: 0.05, elN: 0.2, shF: -0.05, elF: 0.2 },
  wave: { ...BASE, head: 0.35, shN: 2.75, elN: 0.2 },
  bend: { ...BASE, pelvisY: 2.3, lean: 0.95, head: -0.2, shN: 0.05, elN: 0.1, shF: 0.0, elF: 0.15, hipN: 0.35, knN: 0.45, hipF: 0.2, knF: 0.35 },
  tired: { ...BASE, pelvisY: 2.4, lean: 0.28, head: -0.35, shN: -0.05, elN: 0.05, shF: -0.08, elF: 0.05, hipN: 0.08, knN: 0.12, hipF: -0.04, knF: 0.1 },
  sit: { ...BASE, pelvisY: 0.42, lean: -0.12, head: 0.1, shN: 0.9, elN: 1.1, shF: 0.8, elF: 1.2, hipN: 1.25, knN: 2.3, hipF: 1.15, knF: 2.25 },
};

export function blendPose(a, b, t) {
  const o = {};
  for (const k in a) o[k] = lerp(a[k], b[k] ?? a[k], t);
  return o;
}

/** Walking/running cycle layered on a base pose. amp 1 = walk, ~1.8 = run. */
export function gait(base, phase, amp = 1) {
  const s = Math.sin(phase);
  const c = Math.cos(phase);
  const run = Math.max(0, amp - 1);
  return {
    ...base,
    pelvisY: base.pelvisY + 0.06 * amp * Math.abs(c) - 0.1 * run,
    lean: base.lean + 0.18 * run + 0.02,
    hipN: 0.42 * amp * s,
    hipF: -0.42 * amp * s,
    knN: 0.08 + 0.75 * amp * Math.max(0, Math.sin(phase + 1.3)),
    knF: 0.08 + 0.75 * amp * Math.max(0, Math.sin(phase + Math.PI + 1.3)),
    shN: -0.34 * amp * s,
    shF: 0.34 * amp * s,
    elN: 0.2 + 0.5 * run + 0.15 * Math.max(0, -s),
    elF: 0.2 + 0.5 * run + 0.15 * Math.max(0, s),
  };
}

const dirDown = (a) => [Math.sin(a), -Math.cos(a)];

/**
 * Evaluate a pose at foot position (x, y). Returns {segs, head, box} in world
 * units, mirrored when facing < 0. `scale` scales the whole person.
 */
export function rig(pose, x, y, { facing = 1, scale = 1, t = 0, wind = 0.4 } = {}) {
  const D = DIM;
  const pel = [0, pose.pelvisY];
  const td = [Math.sin(pose.lean), Math.cos(pose.lean)];
  const sh = [pel[0] + td[0] * D.torso, pel[1] + td[1] * D.torso];
  const neckTop = [sh[0] + Math.sin(pose.lean * 0.6 - pose.head * 0.5) * D.neck, sh[1] + D.neck];
  const headC = [neckTop[0] + Math.sin(pose.lean * 0.5 - pose.head * 0.6) * 0.22 + 0.04, neckTop[1] + D.head * 0.95];
  const limb = (root, a1, a2, l1, l2) => {
    const d1 = dirDown(a1);
    const j = [root[0] + d1[0] * l1, root[1] + d1[1] * l1];
    const d2 = dirDown(a2);
    const e = [j[0] + d2[0] * l2, j[1] + d2[1] * l2];
    return [j, e];
  };
  const shoulder = [sh[0] - td[0] * 0.18, sh[1] - td[1] * 0.18];
  const [elbN, wrN] = limb(shoulder, pose.shN, pose.shN + pose.elN, D.upper, D.fore);
  const [elbF, wrF] = limb(shoulder, pose.shF, pose.shF + pose.elF, D.upper, D.fore);
  const [knN, anN] = limb(pel, pose.hipN, pose.hipN - pose.knN, D.thigh, D.shin);
  const [knF, anF] = limb(pel, pose.hipF, pose.hipF - pose.knF, D.thigh, D.shin);
  const footDir = (hip, kn) => {
    const a = (hip - kn) * 0.35;
    return [Math.cos(a), Math.sin(a)];
  };
  const fN = footDir(pose.hipN, pose.knN);
  const fF = footDir(pose.hipF, pose.knF);
  const toeN = [anN[0] + fN[0] * D.foot, anN[1] + fN[1] * D.foot];
  const toeF = [anF[0] + fF[0] * D.foot, anF[1] + fF[1] * D.foot];
  const kneeMid = [(knN[0] + knF[0]) / 2, (knN[1] + knF[1]) / 2];
  const hem = [pel[0] + (kneeMid[0] - pel[0]) * 0.72, pel[1] + (kneeMid[1] - pel[1]) * 0.72];
  const chest = [pel[0] + td[0] * D.torso * 0.72, pel[1] + td[1] * D.torso * 0.72];
  // scarf trailing behind the neck, fluttering
  const fl = Math.sin(t * 7.3) * 0.08 + Math.sin(t * 11.1) * 0.04;
  const sc0 = [neckTop[0] - 0.08, neckTop[1] - 0.12];
  const sc1 = [sc0[0] - (0.3 + wind * 0.3), sc0[1] - 0.5 + fl * 0.6 + wind * 0.15];

  // [ax, ay, bx, by, ra, rb]
  let segs = [
    [elbF[0], elbF[1], wrF[0], wrF[1], 0.085, 0.07],
    [shoulder[0], shoulder[1], elbF[0], elbF[1], 0.105, 0.088],
    [knF[0], knF[1], anF[0], anF[1], 0.115, 0.075],
    [pel[0], pel[1], knF[0], knF[1], 0.165, 0.12],
    [anF[0], anF[1], toeF[0], toeF[1], 0.075, 0.05],
    [pel[0], pel[1], sh[0], sh[1], 0.27, 0.3],
    [chest[0], chest[1], hem[0], hem[1], 0.3, 0.44],
    [sh[0], sh[1], neckTop[0], neckTop[1], 0.1, 0.09],
    [neckTop[0], neckTop[1] - 0.05, neckTop[0] - 0.05, neckTop[1] - 0.2, 0.11, 0.1],
    [knN[0], knN[1], anN[0], anN[1], 0.115, 0.075],
    [pel[0], pel[1], knN[0], knN[1], 0.165, 0.12],
    [anN[0], anN[1], toeN[0], toeN[1], 0.075, 0.05],
    [shoulder[0], shoulder[1], elbN[0], elbN[1], 0.105, 0.088],
    [elbN[0], elbN[1], wrN[0], wrN[1], 0.085, 0.07],
  ];
  const tf = (px, py) => [x + px * scale * facing, y + py * scale];
  segs = segs.map((s) => {
    const a = tf(s[0], s[1]);
    const b = tf(s[2], s[3]);
    return [a[0], a[1], b[0], b[1], s[4] * scale, s[5] * scale];
  });
  const hc = tf(headC[0], headC[1]);
  const head = [hc[0], hc[1], D.head * scale, facing];
  let minx = Infinity;
  let miny = Infinity;
  let maxx = -Infinity;
  let maxy = -Infinity;
  for (const s of segs) {
    minx = Math.min(minx, s[0] - s[4], s[2] - s[5]);
    maxx = Math.max(maxx, s[0] + s[4], s[2] + s[5]);
    miny = Math.min(miny, s[1] - s[4], s[3] - s[5]);
    maxy = Math.max(maxy, s[1] + s[4], s[3] + s[5]);
  }
  minx = Math.min(minx, head[0] - head[2] * 1.8);
  maxx = Math.max(maxx, head[0] + head[2] * 1.8);
  maxy = Math.max(maxy, head[1] + head[2] * 1.8);
  const pad = 0.3 * scale;
  return {
    segs,
    head,
    box: [minx - pad, miny - pad, maxx - minx + 2 * pad, maxy - miny + 2 * pad],
    hand: tf(wrN[0], wrN[1]),
    handFar: tf(wrF[0], wrF[1]),
    headPos: hc,
  };
}
