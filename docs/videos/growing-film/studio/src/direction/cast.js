// The cast: three canon cats and the person, act by act.

import { catItem, walkFrame, breathe, pop } from '../scene/cats.js';
import { rig, POSES, blendPose, gait } from '../scene/human.js';
import { hill } from '../scene/world.js';
import { keys, ease, clamp, smoothstep, ramp, lerp } from '../util.js';
import { C } from '../palette.js';

const E = ease;

/** Pose timeline helper: [[t, pose], ...] → {pose, since} */
function poseAt(list, t) {
  let cur = list[0];
  for (const p of list) if (t >= p[0]) cur = p;
  return { pose: cur[1], since: cur[0], extra: cur[2] };
}

function place(ctx, S, cat, pose, x, o = {}) {
  const y = o.y ?? hill(x);
  const it = catItem(ctx.cats, cat, pose, x, y, o);
  (o.front ? S.catsFront : S.cats).push(it);
  return it;
}

// ---------------- act 1: the seed ----------------
function act1(S, t, ctx) {
  const seedL0 = ctx.seedLight(t);
  const seedL = { ...seedL0, i: seedL0.i * 0.32 };
  const lit = smoothstep(5.5, 9.0, t); // the seed approaches and lights them
  const sil = lerp(0.7, 0.28, lit) * (1 - smoothstep(15, 18, t));
  const glowRim = 0.06 * lit * (1 - smoothstep(14, 18, t));
  const common = { pts: [seedL], sil, glowRim };
  const cats = [
    { cat: 'siamese', x: -3.25, flip: true, seq: [[0, 'sit'], [6.2, 'look-up'], [9.15, 'look-down'], [15.2, 'sit'], [16.6, 'tail-up']] },
    { cat: 'ragdoll', x: -1.5, flip: true, seq: [[0, 'sit'], [6.0, 'look-up'], [9.05, 'look-down'], [13.5, 'paw'], [14.7, 'look-down'], [16.2, 'sit']] },
    { cat: 'maine', x: 1.72, flip: false, seq: [[0, 'loaf'], [6.4, 'look-up'], [9.25, 'look-down'], [15.6, 'sit']] },
  ];
  for (const c of cats) {
    const p = poseAt(c.seq, t);
    const b = breathe(t, c.x);
    const q = pop(t, p.since);
    let x = c.x;
    if (c.cat === 'ragdoll' && p.pose === 'paw') x = lerp(-1.5, -1.12, ramp(t, 13.5, 13.8, E.outCubic));
    place(ctx, S, c.cat, p.pose, x, { ...common, flip: c.flip, squash: [b[0] * q[0], b[1] * q[1]] });
  }
  // the person, kneeling on the right, facing the seed
  let pose = POSES.kneel;
  if (t > 8.6) pose = blendPose(POSES.kneel, POSES.kneelPress, ramp(t, 8.6, 9.3, E.inOutSine));
  if (t > 11.2) pose = blendPose(POSES.kneelPress, POSES.crouchLook, ramp(t, 11.2, 12.2, E.inOutSine));
  if (t > 15.5) pose = blendPose(POSES.crouchLook, POSES.kneel, ramp(t, 15.5, 16.5, E.inOutSine));
  if (t < 8.6) pose = blendPose(POSES.kneel, POSES.kneelUp, ramp(t, 4.5, 6.5, E.inOutSine) * (1 - ramp(t, 7.4, 8.6)));
  const r = rig(pose, 4.05, hill(4.05), { facing: -1, t, wind: 0.5 });
  S.humans.push({ ...r, pt: seedL0, body: [0.004, 0.005, 0.009], rimCol: mix(S.light.rimCol, [0.9, 0.55, 0.3], lit * 0.5), rimW: 0.08 });
}

function mix(a, b, t) {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

export function castAt(S, t, ctx) {
  if (t < 18.2) act1(S, t, ctx);
  if (ctx.acts) for (const a of ctx.acts) a(S, t, ctx);
}

export { place, poseAt };
