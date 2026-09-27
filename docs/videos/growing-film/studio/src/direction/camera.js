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
  [54.0, [5.5, 7.6, 20], E.inOutCubic],
  // act 4: trust
  [57.0, [8.0, 8.0, 20], E.inOutSine],
  [60.0, [11.2, 11.4, 13.5], E.inOutCubic],
  [64.5, [12.4, 12.9, 11.2], E.inOutSine],
  [66.0, [15.8, 13.4, 7.6], E.inOutCubic],
  [69.0, [15.0, 12.6, 9.6], E.inOutSine],
  [72.0, [15.8, 13.2, 9.2], E.inOutSine],
  [73.5, [14.6, 15.0, 11.5], E.inOutSine],
  [75.0, [6.0, 24.0, 36], E.inOutCubic],
  // act 5: fruit — Maine Coon, Ragdoll, Siamese, then the whole tree
  [76.6, [15.4, 18.3, 10.2], E.inOutCubic],
  [81.5, [15.2, 18.5, 9.4], E.inOutSine],
  [83.2, [10.6, 18.2, 10.0], E.inOutCubic],
  [87.5, [10.4, 18.4, 9.2], E.inOutSine],
  [89.2, [5.4, 17.8, 10.0], E.inOutCubic],
  [92.6, [5.2, 18.0, 9.2], E.inOutSine],
  [96.0, [4.0, 25.0, 64], E.inOutCubic],
  // act 6: fall, sprout, forest, stars
  [97.3, [14.0, 8.0, 26], E.inOutSine],
  [98.6, [26.0, 3.2, 12], E.inOutCubic],
  [100.2, [24.0, 5.0, 17], E.inOutSine],
  [105.0, [4.0, 26.0, 150], E.inOutCubic],
  [108.0, [0.0, 90.0, 190], E.inOutSine],
  [111.0, [0.0, 200.0, 220], E.inOutCubic],
  [122.5, [0.0, 214.0, 220], E.linear],
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
