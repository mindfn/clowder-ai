// Staging that depends on the grown tree's geometry (limbs, perches, fruit
// spots) is computed once here; later acts and the camera read from ctx.

import { act2 } from './act2.js';

export async function setupStaging(ctx) {
  ctx.shots = null;
  ctx.acts = [act2];
  ctx.moreFx = [];
  ctx.shakes = [
    { t: 35.25, dur: 0.4, amp: 0.6, decay: 9 },
    { t: 36.0, dur: 1.4, amp: 2.4, decay: 3.2 },
  ];
}
