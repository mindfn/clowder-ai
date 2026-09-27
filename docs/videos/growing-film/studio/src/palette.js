// Colour language of the film (linear RGB). Sky states blend by name.

import { hexToLinear as L, mix3, clamp } from './util.js';

export const SKY = {
  night: { zenith: L('#02040d'), mid: L('#070c22'), horizon: L('#16224a'), stars: 1, milky: 0.8 },
  deepNight: { zenith: L('#010208'), mid: L('#040716'), horizon: L('#0b1330'), stars: 1.1, milky: 1 },
  predawn: { zenith: L('#060b24'), mid: L('#1d2656'), horizon: L('#6a4f7a'), stars: 0.55, milky: 0.3 },
  dawn: { zenith: L('#18306a'), mid: L('#6f79b0'), horizon: L('#f3a77a'), stars: 0.05, milky: 0 },
  day: { zenith: L('#2c69c9'), mid: L('#6fa6e0'), horizon: L('#cfe6f6'), stars: 0, milky: 0 },
  golden: { zenith: L('#2a4f98'), mid: L('#c58a7a'), horizon: L('#ffc27a'), stars: 0, milky: 0 },
  dusk: { zenith: L('#1a1a4a'), mid: L('#7a3f6a'), horizon: L('#ff8a4c'), stars: 0.15, milky: 0 },
  lateDusk: { zenith: L('#0c1034'), mid: L('#3b2556'), horizon: L('#b0506a'), stars: 0.45, milky: 0.1 },
  aurora: { zenith: L('#01030c'), mid: L('#031022'), horizon: L('#0a2238'), stars: 1, milky: 0.7 },
};

export function skyMix(a, b, t) {
  const A = SKY[a];
  const B = SKY[b];
  t = clamp(t);
  return {
    zenith: mix3(A.zenith, B.zenith, t),
    mid: mix3(A.mid, B.mid, t),
    horizon: mix3(A.horizon, B.horizon, t),
    stars: A.stars + (B.stars - A.stars) * t,
    milky: A.milky + (B.milky - A.milky) * t,
  };
}

export const LEAF = {
  spring: { lit: L('#d8f08a'), mid: L('#7fc25a'), shadow: L('#2e6a45'), rim: L('#f4ffc0') },
  summer: { lit: L('#9fdc6a'), mid: L('#3f9a52'), shadow: L('#15402f'), rim: L('#e0ffb0') },
  autumn: { lit: L('#ffd27a'), mid: L('#e0783c'), shadow: L('#6a2626'), rim: L('#fff0b0') },
  dusk: { lit: L('#ffb27a'), mid: L('#7a6a4a'), shadow: L('#1d2a26'), rim: L('#ffd0a0') },
  night: { lit: L('#4a8a9a'), mid: L('#1f4a52'), shadow: L('#0a1a22'), rim: L('#8ff0ff') },
  bloom: { lit: L('#7ad0c0'), mid: L('#2a6a6a'), shadow: L('#0c2228'), rim: L('#c8fff0') },
};

export function leafMix(a, b, t) {
  const A = LEAF[a];
  const B = LEAF[b];
  t = clamp(t);
  return { lit: mix3(A.lit, B.lit, t), mid: mix3(A.mid, B.mid, t), shadow: mix3(A.shadow, B.shadow, t), rim: mix3(A.rim, B.rim, t) };
}

export const C = {
  seed: L('#ffcf7a', 3.2),
  seedCore: L('#fff4d6', 6),
  gold: L('#ffc56b'),
  rose: L('#ff8fb8'),
  aqua: L('#5ff2d8'),
  opus: L('#60A5FA'),
  codex: L('#34D399'),
  gemini: L('#FBBF24'),
  lantern: L('#ffb35a'),
  warning: L('#ff5a3c'),
  moon: L('#b8c8ff'),
};
