// Particles, light trails, captions and grading beats.

import { K, motes, burst, ripples, fireflies, grass, falling } from '../scene/particles.js';
import { seedPos, seedGlow } from './seed.js';
import { hill } from '../scene/world.js';
import { ramp, envelope, ease, smoothstep, clamp, lerp } from '../util.js';
import { C } from '../palette.js';

const E = ease;

function seedFx(S, t) {
  if (t > 19) return;
  const [x, y] = seedPos(t);
  const g = seedGlow(t);
  const P = S.parts.mid;
  const under = t > 9.3;
  const sz = t < 3 ? 0.07 : t < 9 ? lerp(0.07, 0.05, ramp(t, 3, 9)) : 0.045;
  P.push(x, y, 0.02, sz * (0.9 + 0.3 * g), C.seedCore[0], C.seedCore[1], C.seedCore[2], g * (under ? 0.8 : 1.4), 0, K.glow);
  if (!under) P.push(x, y, 0.02, sz * 2.4, C.seed[0], C.seed[1], C.seed[2], g * 0.35, t * 0.3, K.sparkle);
  // trail while it falls
  if (t > 3.0 && t < 9.3) {
    const pts = [];
    for (let k = 0; k <= 24; k++) {
      const tt = t - k * 0.03 * (t < 6 ? 1.2 : 0.6);
      if (tt < 3.0) break;
      const p = seedPos(tt);
      const f = 1 - k / 24;
      pts.push([p[0], p[1], f * (t < 6 ? 1 : 0.6), f]);
    }
    pts.reverse();
    S.ribbons.push({ pts, width: 0.035, color: [C.seed[0] * 0.5, C.seed[1] * 0.45, C.seed[2] * 0.4, 1], core: 1.6, alpha: 1 - smoothstep(8.5, 9.2, t) });
  }
  // landing: sparks, surface ripples, a ring of light through the soil
  burst(P, t, 9.0, { x: 0, y: 0.05, n: 46, speed: 2.4, life: 1.6, size: 0.05, col: [2.2, 1.5, 0.7], gravity: -0.9, dir: Math.PI / 2, spread: 2.6, seed: 17 });
  ripples(P, t, 9.0, { x: 0, y: 0.02, count: 3, gap: 0.38, speed: 2.8, life: 2.4, col: [1.6, 1.0, 0.45], aspect: 0.2 });
  if (t > 9.0 && t < 13) S.ground.ripple = { amt: 1.4 * (1 - smoothstep(9.0, 12.5, t)), c: [0, -0.2], r: (t - 9.0) * 5.2, col: [1.0, 0.62, 0.25] };
  // soil crumble as it sinks
  burst(P, t, 9.1, { x: 0, y: 0.0, n: 16, speed: 0.9, life: 0.9, size: 0.03, col: [0.08, 0.05, 0.035], gravity: -3.5, dir: Math.PI / 2, spread: 2.2, seed: 29, kind: K.glow });
  // sprout: sparkles as it breaks the surface
  burst(P, t, 12.05, { x: 0, y: 0.1, n: 30, speed: 1.1, life: 1.5, size: 0.035, col: [1.6, 2.0, 0.9], gravity: 0.3, dir: Math.PI / 2, spread: 1.6, seed: 31 });
  // glow from the seed lights the soil around it
  S.ground.glows.push({ x, y, r: under ? 0.75 : 1.6, i: g * (under ? 1.3 : 0.7) * (1 - smoothstep(15, 18, t)), col: [1.0, 0.6, 0.28] });
}

function captions(S, t, ctx) {
  for (const c of ctx.captions) {
    if (t < c.at - 0.1 || t > c.until + 0.1) continue;
    const a = envelope(t, c.at, c.at + 0.9, c.until - 0.8, c.until, E.inOutSine);
    const w = c.tex.w;
    const h = c.tex.h;
    const y = c.style === 'fruit' ? 120 : 84;
    S.captions.push({
      tex: c.tex,
      rect: [(1920 - w) / 2, y + 6 * (1 - ramp(t, c.at, c.at + 1.4, E.outCubic)), w, h],
      alpha: a,
      reveal: ramp(t, c.at, c.at + 1.3, E.outCubic),
      blurLod: 2.2 * (1 - ramp(t, c.at, c.at + 0.9, E.outCubic)) + 2.0 * ramp(t, c.until - 0.8, c.until, E.inSine),
      soft: 0.22,
      tint: [1, 1, 1],
    });
  }
}

export function fxAt(S, t, ctx) {
  seedFx(S, t);
  // ambient motes near the group (act 1), lit gold after the landing
  if (t < 19) {
    const a = 0.25 + 0.75 * smoothstep(8.5, 10, t);
    motes(S.parts.mid, t, { n: 70, x0: -6, x1: 7, y0: -0.4, y1: 5, z0: -0.6, z1: 0.6, size: 0.022, col: [1.4, 1.0, 0.55], alpha: a * (1 - smoothstep(17, 19, t)), seed: 3, speed: 0.12 });
    motes(S.parts.fg, t, { n: 16, x0: -5, x1: 6, y0: 0.2, y1: 4, z0: 2.2, z1: 3.4, size: 0.035, col: [1.2, 0.85, 0.5], alpha: a * 0.8 * (1 - smoothstep(16, 18.5, t)), seed: 8, speed: 0.1, kind: K.bokeh });
  }
  // grass along the ridge of the hill
  const gcol = t < 15 ? [0.012, 0.016, 0.02] : [0.05, 0.08, 0.035];
  grass(S.parts.midBack, t, { x0: S.cam.x - S.cam.V * 1.2, x1: S.cam.x + S.cam.V * 1.2, ground: hill, z: -0.05, density: Math.min(40, 90 / Math.max(S.cam.V, 1) * 4), height: 0.32, col: gcol, seed: 4, wind: t > 18 && t < 24 ? 2 : 0.7 });
  if (ctx.moreFx) for (const f of ctx.moreFx) f(S, t, ctx);
  captions(S, t, ctx);
  if (ctx.overlayFx) for (const f of ctx.overlayFx) f(S, t, ctx);
  // fades
  S.post.fade = Math.max(1 - ramp(t, 0.0, 1.8, E.inOutSine), ramp(t, 120.2, 122.2, E.inOutSine));
  // the break: a white flash, then a breath of exposure
  S.post.flash = Math.max(S.post.flash ?? 0, ramp(t, 35.93, 36.0) * (1 - ramp(t, 36.0, 36.55, E.outCubic)) * 0.85);
}
