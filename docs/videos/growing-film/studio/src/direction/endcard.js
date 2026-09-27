// End card: the mark resolves out of the gathered stars, then the title and
// the invitation. Screen-space, drawn after grading.

import { ramp, ease, envelope } from '../util.js';

const E = ease;

export function endCard(S, t, ctx) {
  if (t < 110.8) return;
  const size = 400;
  const a = ramp(t, 111.0, 112.6, E.inOutSine) * (1 - ramp(t, 120.4, 122.0, E.inOutSine));
  const rect = [960 - size / 2, 680 - size / 2, size, size];
  // soft halo first, then the crisp mark
  // the halo texture holds the mark at 56% of its size: scale it so the two line up
  const hs = size / 0.56;
  S.captions.push({ tex: ctx.haloTex, rect: [960 - hs / 2, 680 - hs / 2, hs, hs], alpha: a * 0.55, reveal: 1, blurLod: 0, soft: 0.01, tint: [1.0, 0.68, 0.38] });
  S.captions.push({ tex: ctx.markTex, rect, alpha: a, reveal: 1, blurLod: 3 * (1 - ramp(t, 111.0, 112.8, E.outCubic)), soft: 0.01, tint: [1.0, 0.9, 0.76] });
  const ta = ramp(t, 112.6, 114.0, E.inOutSine) * (1 - ramp(t, 120.4, 122.0, E.inOutSine));
  S.captions.push({ tex: ctx.titleTex, rect: [960 - 700, 250, 1400, 240], alpha: ta, reveal: ramp(t, 112.6, 114.2, E.outCubic), blurLod: 2 * (1 - ramp(t, 112.6, 113.8)), soft: 0.2, tint: [1, 0.96, 0.9] });
  const ga = ramp(t, 114.2, 115.6, E.inOutSine) * (1 - ramp(t, 120.4, 122.0, E.inOutSine));
  S.captions.push({ tex: ctx.taglineTex, rect: [60, 70, 1800, 190], alpha: ga, reveal: ramp(t, 114.2, 115.8, E.outCubic), blurLod: 1.5 * (1 - ramp(t, 114.2, 115.2)), soft: 0.2, tint: [1, 1, 1] });
}
