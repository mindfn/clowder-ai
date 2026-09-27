// Time of day, sky, distant ridges, soil and the global light, as "looks"
// blended over film time. Act 2 runs a time-lapse through whole days.

import { clamp, lerp, smoothstep, mix3, hexToLinear as HX, TAU } from '../util.js';
import { skyMix } from '../palette.js';

// A look: { sky:[a,b,t], sun, moon, clouds, aurora, light, soil, ridge, post }
const LOOK = {
  night: {
    sky: ['deepNight', 'night', 0.4], sunI: 0, moonI: 1, clouds: 0.0,
    light: { keyDir: [-0.55, 0.8], keyCol: [0.03, 0.04, 0.07], ambient: [0.012, 0.016, 0.03], rimCol: [0.16, 0.22, 0.4], catAmbient: [0.035, 0.042, 0.07], catKey: [0.06, 0.07, 0.11] },
    soil: { top: [0.02, 0.015, 0.013], deep: [0.006, 0.005, 0.007], edge: [0.02, 0.03, 0.06], cut: 1 },
    ridge: { dark: [0.004, 0.006, 0.014], haze: 0.55, rim: [0.05, 0.07, 0.14] },
    post: { exposure: 1.15, sat: 1.0, contrast: 1.04, bloom: 0.42, lift: [0.004, 0.006, 0.014], gain: [1, 1, 1.02], shadowTint: [0.0, 0.1, 0.25], highTint: [0.3, 0.15, 0.0] },
  },
  predawn: {
    sky: ['predawn', 'predawn', 0], sunI: 0, moonI: 0.5, clouds: 0.15,
    light: { keyDir: [0.8, 0.25], keyCol: [0.1, 0.08, 0.12], ambient: [0.03, 0.03, 0.06], rimCol: [0.45, 0.3, 0.4], catAmbient: [0.1, 0.1, 0.14], catKey: [0.12, 0.1, 0.14] },
    soil: { top: [0.03, 0.022, 0.018], deep: [0.008, 0.006, 0.008], edge: [0.06, 0.05, 0.08], cut: 1 },
    ridge: { dark: [0.01, 0.01, 0.025], haze: 0.6, rim: [0.25, 0.15, 0.18] },
    post: { exposure: 1.1, sat: 1.0, contrast: 1.03, bloom: 0.38, lift: [0.006, 0.006, 0.014], gain: [1.02, 1, 1], shadowTint: [0.05, 0.05, 0.2], highTint: [0.35, 0.18, 0.05] },
  },
  dawn: {
    sky: ['dawn', 'dawn', 0], sunI: 0.9, moonI: 0, clouds: 0.35,
    light: { keyDir: [0.92, 0.3], keyCol: [0.9, 0.55, 0.35], ambient: [0.1, 0.1, 0.16], rimCol: [1.3, 0.7, 0.4], catAmbient: [0.3, 0.28, 0.34], catKey: [0.4, 0.3, 0.24] },
    soil: { top: [0.05, 0.036, 0.028], deep: [0.012, 0.009, 0.01], edge: [0.25, 0.14, 0.08], cut: 1 },
    ridge: { dark: [0.03, 0.03, 0.06], haze: 0.7, rim: [0.8, 0.4, 0.25] },
    post: { exposure: 1.0, sat: 1.05, contrast: 1.02, bloom: 0.34, lift: [0.01, 0.008, 0.014], gain: [1.03, 1, 0.98], shadowTint: [0.1, 0.05, 0.2], highTint: [0.4, 0.2, 0.0] },
  },
  day: {
    sky: ['day', 'day', 0], sunI: 1.0, moonI: 0, clouds: 0.45,
    light: { keyDir: [0.45, 0.88], keyCol: [0.95, 0.9, 0.8], ambient: [0.2, 0.25, 0.33], rimCol: [0.7, 0.65, 0.5], catAmbient: [0.55, 0.57, 0.62], catKey: [0.5, 0.47, 0.42] },
    soil: { top: [0.11, 0.075, 0.05], deep: [0.025, 0.018, 0.016], edge: [0.35, 0.3, 0.2], cut: 1 },
    ridge: { dark: [0.05, 0.08, 0.07], haze: 0.72, rim: [0.2, 0.2, 0.15] },
    post: { exposure: 0.95, sat: 1.08, contrast: 1.03, bloom: 0.24, lift: [0.01, 0.012, 0.018], gain: [1.02, 1.01, 0.99], shadowTint: [0.0, 0.08, 0.15], highTint: [0.25, 0.15, 0.0] },
  },
  overcast: {
    sky: ['day', 'lateDusk', 0.35], sunI: 0.15, moonI: 0, clouds: 0.95,
    light: { keyDir: [0.3, 0.9], keyCol: [0.35, 0.37, 0.4], ambient: [0.16, 0.17, 0.2], rimCol: [0.35, 0.38, 0.45], catAmbient: [0.42, 0.43, 0.47], catKey: [0.25, 0.25, 0.27] },
    soil: { top: [0.07, 0.05, 0.04], deep: [0.02, 0.015, 0.014], edge: [0.18, 0.18, 0.2], cut: 1 },
    ridge: { dark: [0.05, 0.055, 0.07], haze: 0.8, rim: [0.1, 0.1, 0.12] },
    post: { exposure: 0.95, sat: 0.72, contrast: 1.06, bloom: 0.2, lift: [0.012, 0.014, 0.02], gain: [0.98, 1.0, 1.03], shadowTint: [0.0, 0.05, 0.12], highTint: [0.0, 0.0, 0.05] },
  },
  golden: {
    sky: ['golden', 'golden', 0], sunI: 1.0, moonI: 0, clouds: 0.4,
    light: { keyDir: [0.9, 0.35], keyCol: [1.05, 0.7, 0.4], ambient: [0.14, 0.12, 0.16], rimCol: [1.4, 0.8, 0.4], catAmbient: [0.4, 0.34, 0.34], catKey: [0.55, 0.4, 0.28] },
    soil: { top: [0.08, 0.05, 0.035], deep: [0.02, 0.014, 0.014], edge: [0.5, 0.3, 0.14], cut: 1 },
    ridge: { dark: [0.05, 0.035, 0.06], haze: 0.72, rim: [1.0, 0.5, 0.25] },
    post: { exposure: 0.98, sat: 1.1, contrast: 1.03, bloom: 0.36, lift: [0.012, 0.008, 0.014], gain: [1.04, 1.0, 0.95], shadowTint: [0.1, 0.03, 0.18], highTint: [0.45, 0.2, 0.0] },
  },
  dusk: {
    sky: ['dusk', 'dusk', 0], sunI: 0.95, moonI: 0, clouds: 0.5,
    light: { keyDir: [0.95, 0.22], keyCol: [1.0, 0.5, 0.28], ambient: [0.09, 0.07, 0.12], rimCol: [1.5, 0.62, 0.32], catAmbient: [0.3, 0.24, 0.3], catKey: [0.45, 0.28, 0.2] },
    soil: { top: [0.05, 0.032, 0.026], deep: [0.012, 0.008, 0.01], edge: [0.45, 0.2, 0.12], cut: 1 },
    ridge: { dark: [0.04, 0.02, 0.05], haze: 0.62, rim: [1.1, 0.42, 0.22] },
    post: { exposure: 1.0, sat: 1.1, contrast: 1.04, bloom: 0.42, lift: [0.014, 0.006, 0.016], gain: [1.05, 0.99, 0.95], shadowTint: [0.12, 0.02, 0.22], highTint: [0.5, 0.2, 0.0] },
  },
  lateDusk: {
    sky: ['lateDusk', 'lateDusk', 0], sunI: 0.35, moonI: 0.3, clouds: 0.35,
    light: { keyDir: [0.9, 0.18], keyCol: [0.35, 0.18, 0.16], ambient: [0.04, 0.035, 0.07], rimCol: [0.8, 0.35, 0.3], catAmbient: [0.14, 0.12, 0.17], catKey: [0.18, 0.12, 0.12] },
    soil: { top: [0.03, 0.02, 0.018], deep: [0.008, 0.006, 0.008], edge: [0.2, 0.1, 0.1], cut: 1 },
    ridge: { dark: [0.02, 0.012, 0.035], haze: 0.55, rim: [0.5, 0.2, 0.18] },
    post: { exposure: 1.08, sat: 1.05, contrast: 1.04, bloom: 0.46, lift: [0.01, 0.006, 0.018], gain: [1.03, 0.99, 1.0], shadowTint: [0.1, 0.02, 0.25], highTint: [0.4, 0.15, 0.0] },
  },
  bloomNight: {
    sky: ['night', 'deepNight', 0.3], sunI: 0, moonI: 0.8, clouds: 0.05,
    light: { keyDir: [-0.5, 0.85], keyCol: [0.04, 0.05, 0.08], ambient: [0.015, 0.02, 0.035], rimCol: [0.2, 0.3, 0.45], catAmbient: [0.08, 0.09, 0.12], catKey: [0.1, 0.11, 0.15] },
    soil: { top: [0.02, 0.016, 0.016], deep: [0.006, 0.005, 0.008], edge: [0.03, 0.05, 0.08], cut: 1 },
    ridge: { dark: [0.004, 0.008, 0.016], haze: 0.5, rim: [0.06, 0.1, 0.16] },
    post: { exposure: 1.18, sat: 1.08, contrast: 1.05, bloom: 0.55, lift: [0.004, 0.008, 0.016], gain: [1.0, 1.01, 1.03], shadowTint: [0.0, 0.12, 0.25], highTint: [0.35, 0.15, 0.05] },
  },
  aurora: {
    sky: ['aurora', 'aurora', 0], sunI: 0, moonI: 0, clouds: 0.0, aurora: 1,
    light: { keyDir: [0.0, 1.0], keyCol: [0.03, 0.07, 0.07], ambient: [0.012, 0.025, 0.035], rimCol: [0.15, 0.45, 0.4], catAmbient: [0.08, 0.1, 0.12], catKey: [0.08, 0.12, 0.12] },
    soil: { top: [0.018, 0.016, 0.016], deep: [0.005, 0.005, 0.008], edge: [0.03, 0.08, 0.08], cut: 1 },
    ridge: { dark: [0.003, 0.008, 0.014], haze: 0.45, rim: [0.05, 0.16, 0.14] },
    post: { exposure: 1.2, sat: 1.1, contrast: 1.05, bloom: 0.6, lift: [0.004, 0.008, 0.016], gain: [1.0, 1.02, 1.03], shadowTint: [0.0, 0.14, 0.22], highTint: [0.3, 0.2, 0.05] },
  },
};

function lerpDeep(a, b, t) {
  if (Array.isArray(a)) return a.map((v, i) => (typeof v === 'number' ? lerp(v, b[i], t) : v));
  if (typeof a === 'number') return lerp(a, b, t);
  if (typeof a === 'string') return t < 0.5 ? a : b;
  const o = {};
  for (const k in a) o[k] = b && k in b ? lerpDeep(a[k], b[k], t) : a[k];
  for (const k in b) if (!(k in o)) o[k] = b[k];
  return o;
}

function skyColors(look) {
  const [a, b, t] = look.sky;
  return skyMix(a, b, t);
}

/** Film-time schedule of looks: [start, end, fromLook, toLook]. */
function lookAt(t) {
  const seg = (t0, t1, a, b) => (t >= t0 && t < t1 ? { a, b, u: smoothstep(t0, t1, t) } : null);
  // act 2 time-lapse: 3 s per day, starting at dawn
  if (t >= 18 && t < 24.4) {
    const tod = (t - 18) / 3 + 0.25;
    return { tod, ...timeLapse(tod, t) };
  }
  const s =
    seg(0, 12, 'night', 'night') ||
    seg(12, 15, 'night', 'predawn') ||
    seg(15, 18, 'predawn', 'dawn') ||
    seg(24.4, 25.6, 'dawn', 'day') ||
    seg(25.6, 29.5, 'day', 'day') ||
    seg(29.5, 35.3, 'day', 'overcast') ||
    seg(35.3, 36.0, 'overcast', 'overcast') ||
    seg(36.0, 39.0, 'overcast', 'golden') ||
    seg(39.0, 51.0, 'golden', 'golden') ||
    seg(51.0, 55.0, 'golden', 'dusk') ||
    seg(55.0, 63.0, 'dusk', 'dusk') ||
    seg(63.0, 70.0, 'dusk', 'lateDusk') ||
    seg(70.0, 76.0, 'lateDusk', 'bloomNight') ||
    seg(76.0, 97.0, 'bloomNight', 'bloomNight') ||
    seg(97.0, 104.0, 'bloomNight', 'aurora') ||
    seg(104.0, 1e9, 'aurora', 'aurora');
  return { look: lerpDeep(LOOK[s.a], LOOK[s.b], s.u), sun: null };
}

function timeLapse(tod, t) {
  const f = ((tod % 1) + 1) % 1;
  // blend through night → dawn → day → golden → dusk → night
  const stops = [
    [0.0, 'night'], [0.19, 'night'], [0.26, 'dawn'], [0.36, 'day'], [0.62, 'day'],
    [0.7, 'golden'], [0.76, 'dusk'], [0.84, 'night'], [1.0, 'night'],
  ];
  let i = 0;
  while (i < stops.length - 2 && f > stops[i + 1][0]) i++;
  const [f0, a] = stops[i];
  const [f1, b] = stops[i + 1];
  const u = smoothstep(f0, f1, f);
  const look = lerpDeep(LOOK[a], LOOK[b], u);
  // sun arcs across the sky; key light follows it
  const th = (f - 0.25) * TAU;
  const el = Math.sin(th);
  look.light = { ...look.light, keyDir: [Math.cos(th) * 0.9, Math.max(0.2, el)] };
  const sun = { x: Math.cos(th) * 1700, y: el * 900 + 60 };
  const moon = { x: -Math.cos(th) * 1500, y: -el * 800 + 120 };
  return { look, sun, moon, lapse: true };
}

const RIDGES = [
  { z: -1100, base: 70, amp: 45, freq: 0.0022, seed: 1.3, treeAmp: 0, treeFreq: 0.1, k: 0.2 },
  { z: -520, base: 22, amp: 18, freq: 0.006, seed: 4.1, treeAmp: 0.45, treeFreq: 0.35, k: 0.45 },
  { z: -220, base: 5, amp: 7, freq: 0.014, seed: 7.7, treeAmp: 0.5, treeFreq: 0.9, k: 0.68 },
  { z: -80, base: 0.8, amp: 2.2, freq: 0.035, seed: 2.9, treeAmp: 0.55, treeFreq: 1.6, k: 0.88 },
];

export function skyAt(S, t, ctx) {
  const lk = lookAt(t);
  const look = lk.look;
  const sc = skyColors(look);
  const camX = S.cam.x;
  const sun = lk.sun ?? { x: camX * 0.2 + (look.light.keyDir[0] > 0 ? 1300 : -1300), y: 160 + look.light.keyDir[1] * 500 };
  const moon = lk.moon ?? { x: camX * 0.1 - 900, y: 1150 };
  S.look = look;
  S.sky = {
    zenith: sc.zenith,
    mid: sc.mid,
    horizon: sc.horizon,
    horizonShift: ctx.horizonShift ? ctx.horizonShift(t) : 0,
    stars: sc.stars,
    milky: sc.milky,
    aurora: (look.aurora ?? 0) * smoothstep(97, 106, t),
    clouds: look.clouds,
    cloudLit: mix3([1.0, 0.8, 0.65], look.light.keyCol, 0.5),
    cloudShade: mix3(sc.mid, [0.05, 0.05, 0.08], 0.5),
    sun: { ...sun, size: 26, i: look.sunI, col: mix3([1.0, 0.85, 0.6], look.light.keyCol, 0.4) },
    moon: { ...moon, size: 34, i: look.moonI },
  };
  // ridges fade into the horizon colour by distance
  const hz = sc.horizon;
  S.ridges = RIDGES.map((r) => {
    const haze = look.ridge.haze * (1 - r.k);
    const top = mix3(look.ridge.dark, hz, haze);
    const bot = mix3(look.ridge.dark, hz, haze * 0.8);
    const mist = mix3(hz, look.ridge.dark, 0.25 + 0.5 * r.k).map((v, i) => v * (1.05 - 0.35 * r.k));
    return { ...r, colTop: top, colBot: bot, mist, rim: 1, rimCol: look.ridge.rim.map((v) => v * (0.3 + 0.7 * r.k)), alpha: 1, lights: 0 };
  });
  S.light = look.light;
  S.ground = {
    soilTop: look.soil.top,
    soilDeep: look.soil.deep,
    edge: look.soil.edge,
    cut: look.soil.cut,
    ambient: look.light.ambient.map((v) => v * 0.6),
    strata: 1,
    glows: [],
  };
  S.post = { ...look.post, rays: 0, vignette: 0.38, grain: 0.03, ca: 1.0, bloomThresh: 0.9, gamma: 1 };
}
