// One continuous camera for the whole film: [time, [x, y, V]] where V is the
// visible height (world units) on the tree plane. Depth of field per shot.

import { keys, ease, noise1, clamp, smoothstep } from '../util.js';

const E = ease;
// prettier-ignore
const PATH = [
  [0.0, [4.0, 25.5, 12]],
  [3.0, [4.0, 25.0, 12], E.inOutSine],
  [6.0, [1.4, 6.2, 12], E.inOutCubic],
  [9.0, [0.6, 2.25, 8.2], E.inOutCubic],
  [12.0, [0.25, 1.35, 5.8], E.inOutSine],
  [13.4, [0.0, 0.42, 2.7], E.inOutCubic],
  [15.0, [0.0, 0.62, 3.3], E.inOutSine],
  [18.0, [0.0, 1.7, 6.6], E.inOutCubic],
  // act 2: the rush
  [21.0, [0.0, 7.5, 20], E.inOutCubic],
  [24.0, [0.0, 16, 40], E.inOutSine],
  [25.6, [0.4, 3.7, 12.5], E.inOutCubic],
  [33.0, [0.7, 3.6, 11.2], E.inOutSine],
  [35.25, [0.45, 3.0, 9.0], E.inOutCubic],
  [36.0, [0.4, 2.9, 8.6], E.linear],
  // act 3: shatter, dive, network, rings, rise
  [37.5, [0.3, 3.2, 10.5], E.outCubic],
  [40.5, [0.0, -6.5, 21], E.inOutCubic],
  [45.0, [0.0, -8.5, 40], E.inOutSine],
  [45.75, [0.0, -0.8, 3.2], E.inOutCubic],
  [50.25, [0.0, -0.8, 3.0], E.linear],
  [51.0, [0.0, -3.0, 13], E.outCubic],
  [54.0, [2.5, 8.0, 21], E.inOutCubic],
  // act 4: trust
  [57.0, [4.0, 7.2, 19], E.inOutSine],
  [60.0, [6.5, 9.0, 19], E.inOutSine],
  [62.5, [0, 0, 0], null], // placeholder replaced at runtime (limb-relative shots)
];

export function cameraAt(S, t, ctx) {
  const shots = ctx.shots; // runtime shot table (depends on tree geometry)
  const path = shots?.path ?? PATH;
  const k = keys(path, t);
  let [x, y, V] = k;
  // impacts shake the camera
  let shake = 0;
  for (const s of ctx.shakes ?? []) {
    const a = t - s.t;
    if (a >= 0 && a < s.dur) shake += s.amp * Math.exp(-a * s.decay);
  }
  if (shake > 0) {
    x += noise1(t * 23 + 1.3) * shake * V * 0.01;
    y += noise1(t * 21 + 7.1) * shake * V * 0.01;
  }
  // subtle handheld breathing so still shots never freeze
  x += noise1(t * 0.31 + 11) * V * 0.0025;
  y += noise1(t * 0.27 + 3) * V * 0.0025;
  const roll = noise1(t * 0.19 + 5) * 0.0025 + (shots?.roll ? shots.roll(t) : 0);
  if (ctx.camOverride) [x, y, V] = ctx.camOverride;
  S.cam = { x, y, V, fov: 34, roll };
  S.dof = shots?.dof ? shots.dof(t, V) : { inf: clamp(22 / V, 0.5, 7), focusZ: 0, bgxZ: -60, fgZ: 2.5, mid: 0 };
}

export { PATH };
export const smoothInOut = smoothstep;
