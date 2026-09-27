// The seed: a pulsing star that falls, floats like a dandelion, lands between
// the person and the cats, sinks into the soil and wakes up.

import { qbez, ramp, ease, lerp, clamp, smoothstep } from '../util.js';
import { C } from '../palette.js';

const E = ease;
const STAR = [6.8, 28.6];
const FALL_END = [1.45, 6.4];

export function seedPos(t) {
  if (t < 3.0) return [STAR[0], STAR[1]];
  if (t < 6.0) {
    const u = E.inOutCubic((t - 3.0) / 3.0);
    return qbez(STAR, [5.6, 12.0], FALL_END, u);
  }
  if (t < 9.0) {
    const u = E.inOutSine((t - 6.0) / 3.0);
    const x = lerp(FALL_END[0], 0, u) + 0.38 * Math.sin(u * Math.PI * 2.4) * (1 - u);
    const y = lerp(FALL_END[1], 0.03, u);
    return [x, y];
  }
  const u = E.outCubic(clamp((t - 9.0) / 0.45));
  return [0, lerp(0.03, -0.36, u)];
}

/** Heartbeat envelope: lub-dub at each listed time. */
export function heart(t, beats) {
  let s = 0;
  for (const b of beats) {
    const a = t - b;
    if (a >= 0 && a < 0.8) s += Math.exp(-a * 10) + 0.6 * (a > 0.28 ? Math.exp(-(a - 0.28) * 11) : 0);
  }
  return s;
}

export function seedGlow(t) {
  const beats = [0.6, 2.1, 9.0, 10.5, 12.0, 13.5];
  const hb = heart(t, beats);
  const base = t < 3 ? 0.55 : t < 9 ? 0.9 : 1.0;
  const fade = 1 - smoothstep(14.5, 18, t);
  return (base + hb * 0.9) * fade;
}

/** Point light cast by the seed on nearby cats, soil and the person. */
export function seedLight(t) {
  const [x, y] = seedPos(t);
  const near = smoothstep(4.5, 8.8, t);
  return {
    x,
    y: y + 0.15,
    r: lerp(1.2, 3.4, near),
    i: seedGlow(t) * lerp(0.2, 1.7, near) * (1 - smoothstep(15, 18.5, t)),
    col: C.seed.map((v) => v * 0.55),
  };
}

export { STAR };
