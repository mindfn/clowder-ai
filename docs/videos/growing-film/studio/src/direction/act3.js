// Act 3 — 扎根 / taking root. After the glass breaks, the camera dives through
// the soil: three coloured streams (one per cat) run down into a single root
// network that lights up; then into the trunk, where the rings light outward,
// inscribed with the real history of the house.

import { BOX_X } from './act2.js';
import { place, poseAt } from './cast.js';
import { rig, POSES, blendPose } from '../scene/human.js';
import { hill } from '../scene/world.js';
import { breathe, pop, CAT_GLOW } from '../scene/cats.js';
import { K, motes, burst } from '../scene/particles.js';
import { ramp, ease, smoothstep, lerp, clamp, envelope, noise1 } from '../util.js';

const E = ease;
const CATS = ['siamese', 'ragdoll', 'maine'];

// Real milestones, innermost ring first (from docs/features and issue #1403).
export const RING_LINES = [
  'F002 · Agent-to-Agent · 第一次传球',
  'F003 · 显式记忆',
  'F065 · 封印重生，记忆不断',
  'F098 · 猫猫传话可视化',
  'F128 · 猫猫提议创建 Thread',
  'F167 · 乒乓球熔断 · 虚空传球检测',
  'F200 · 真实行为的记忆反馈闭环',
  'F225 · 猫主导的 session 接力',
  'F276 · 人物与关系记忆',
  'F311 · 能力进化',
  '#1403 · Growing',
];

function streamPoint(x0, u) {
  // fall straight down from the cat, then bend in towards the root collar
  const fall = Math.min(1, u / 0.35);
  const bend = Math.max(0, (u - 0.25) / 0.75);
  const eb = E.inOutSine(bend);
  const x = lerp(x0, 0.0, eb) + Math.sin(u * 11 + x0) * 0.22 * (1 - eb);
  const y = lerp(hill(x0) - 0.05, -2.6, E.outSine(fall)) * (1 - eb) + lerp(-2.6, -1.1, eb) * eb;
  return [x, y];
}

function streamPath(cat, t, delay) {
  const x0 = BOX_X[cat];
  const head = ramp(t, 38.5 + delay, 40.1 + delay, E.inOutSine);
  const tail = ramp(t, 39.2 + delay, 41.2 + delay, E.inOutSine);
  const pts = [];
  const N = 60;
  for (let k = 0; k <= N; k++) {
    const u = tail + (head - tail) * (k / N);
    if (head - tail < 0.01) break;
    const [x, y] = streamPoint(x0, u);
    const f = k / N; // bright head, fading tail
    pts.push([x, y, 0.35 + 0.9 * f, f * f]);
  }
  return pts;
}

export function act3(S, t, ctx) {
  if (t < 36.0 || t > 54.5) return;
  const L = S.light;
  const P = S.parts.mid;

  // cats stay where their cases were; after the break they come out and look up
  if (t > 40.5) {
    for (const [i, cat] of CATS.entries()) {
      const seq = [[40.5, 'look-up'], [43.5 + i * 0.4, 'sit'], [47 + i * 0.3, 'tail-up'], [50.5, 'look-down']];
      const p = poseAt(seq, t);
      const b = breathe(t, i);
      const q = pop(t, p.since, 0.06);
      place(ctx, S, cat, p.pose, BOX_X[cat], { flip: cat !== 'maine', squash: [b[0] * q[0], b[1] * q[1]], ambient: L.catAmbient, keyCol: L.catKey, glowRim: 0.15 * envelope(t, 38.6, 39.4, 41, 43), pts: [{ x: BOX_X[cat], y: -0.5, r: 1.6, i: 0.8 * envelope(t, 38.4, 39.2, 40.8, 42.5), col: CAT_GLOW[cat] }] });
    }
  }
  // the person straightens up and watches
  if (t > 36.0 && t < 54.5) {
    let pose = blendPose(POSES.tired, POSES.lookUp, ramp(t, 36.6, 38.0, E.inOutSine));
    if (t > 44) pose = blendPose(pose, POSES.stand, ramp(t, 44, 46));
    const r = rig(pose, 0.6, hill(0.6), { facing: 1, t, scale: 0.86 });
    S.humans.push({ ...r, body: [0.012, 0.012, 0.016], rimCol: L.rimCol });
  }

  // three streams
  for (const [i, cat] of CATS.entries()) {
    const pts = streamPath(cat, t, [0.15, 0, 0.3][i]);
    if (pts.length > 1) {
      S.ribbonsUnder.push({ pts, width: 0.2, color: [...CAT_GLOW[cat], 1], core: 1.8, alpha: 1, pulseFreq: 2.5, pulseSpeed: 12, pulseAmt: 1.2 });
      const hp = pts[pts.length - 1];
      const on = t < 40.4 + [0.15, 0, 0.3][i] ? 1 : 0;
      P.push(hp[0], hp[1], 0.05, 0.14, ...CAT_GLOW[cat], 1.6 * on, 0, K.glow);
      P.push(hp[0], hp[1], 0.05, 0.3, ...CAT_GLOW[cat], 0.5 * on, t * 2, K.sparkle);
    }
    // a ripple on the surface where each stream enters
    if (t > 38.4 && t < 40.6) P.push(BOX_X[cat], hill(BOX_X[cat]) + 0.02, 0.05, 0.2 + (t - 38.4) * 1.4, ...CAT_GLOW[cat], 0.8 * (1 - (t - 38.4) / 2.2), 0, K.ring, 0.22);
  }
  // where the streams meet: a bloom of light at the collar
  burst(P, t, 40.2, { x: 0, y: -1.3, n: 60, speed: 4, life: 2.2, size: 0.09, col: [1.6, 1.5, 1.2], gravity: 0, spread: 6.3, seed: 44, kind: K.glow });
  // motes drifting up through the soil while the network lights
  motes(S.parts.mid, t, { n: 120, x0: -36, x1: 36, y0: -16, y1: -0.5, size: 0.07, col: [0.6, 1.1, 1.3], alpha: envelope(t, 40, 43, 50, 52), seed: 13, speed: 0.4 });
  S.ground.lightAmt = 0;

  // ---- rings (inside the trunk)
  const ringsAmt = ramp(t, 45.1, 45.8, E.inOutSine) * (1 - ramp(t, 50.1, 50.9, E.inOutSine));
  if (ringsAmt > 0) {
    const zin = ramp(t, 45.0, 45.9, E.inOutCubic);
    const zout = ramp(t, 50.1, 51.0, E.inCubic);
    const scale = lerp(8, 96, zin) * lerp(1, 0.86, ramp(t, 45.9, 50.1, E.inOutSine)) * lerp(1, 0.06, zout);
    const lit = Math.max(0, (t - 45.75) / 0.36 + 1);
    S.overlays.push({
      amt: ringsAmt,
      center: [960, 540],
      scale,
      lit,
      rings: 12,
      wood: [0.13, 0.068, 0.03],
      late: [0.045, 0.022, 0.011],
      glow: [1.8, 0.95, 0.32],
      glow2: [0.45, 1.1, 1.5],
      spin: (t - 45) * 0.012,
      textTex: ctx.ringsTex,
      rows: RING_LINES.length + 1,
    });
  }
  // grading beats: a warm glow while the rings light
  if (t > 45 && t < 51) S.post.bloom = (S.post.bloom ?? 0.3) + 0.25 * envelope(t, 45.5, 46.5, 49.5, 50.5);
}
