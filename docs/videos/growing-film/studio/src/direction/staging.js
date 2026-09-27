// Staging that depends on the grown tree's geometry (limbs, perches, fruit
// spots) is computed once here; later acts and the camera read from ctx.

import { act2 } from './act2.js';
import { act3, RING_LINES } from './act3.js';
import { act4 } from './act4.js';
import { act5, smallFruitLayout } from './act5.js';
import { act6, buildForest, logoPoints } from './act6.js';
import { endCard } from './endcard.js';
import { ringTextCanvas, titleCanvas, captionCanvas, endLineCanvas, haloCanvas } from '../scene/text.js';
import { canopyClumps } from '../scene/world.js';
import { evaluate } from '../tree.js';

function canopyBottomFn(crown) {
  evaluate(crown, crown.maxD, 1);
  const clumps = canopyClumps(crown, crown.maxD, { keyDir: [0.4, 0.9], scale: 1, size: 2.6, maxL: 24 });
  const env = new Map();
  for (const c of clumps) {
    for (let x = Math.floor(c.x - c.r); x <= Math.ceil(c.x + c.r); x++) {
      const dx = x - c.x;
      if (Math.abs(dx) > c.r) continue;
      const b = c.y - Math.sqrt(c.r * c.r - dx * dx) * 0.9;
      env.set(x, Math.min(env.get(x) ?? 1e9, b));
    }
  }
  return (x) => {
    const x0 = Math.floor(x);
    const a = env.get(x0) ?? 22;
    const b = env.get(x0 + 1) ?? a;
    return a + (b - a) * (x - x0);
  };
}

export async function setupStaging(ctx) {
  const R = ctx.renderer;
  ctx.shots = null;
  ctx.canopyBottom = canopyBottomFn(ctx.world.crown);
  ctx.smallFruits = smallFruitLayout(ctx.canopyBottom);
  ctx.forest = buildForest();
  ctx.logoPoints = await logoPoints('../build/brand/mark.png');
  const mark = new Image();
  mark.src = '../build/brand/mark.png';
  await mark.decode();
  // the mark as a white silhouette, tinted at draw time
  const mc = document.createElement('canvas');
  mc.width = 1024;
  mc.height = 1024;
  const mg = mc.getContext('2d');
  mg.drawImage(mark, 0, 0, 1024, 1024);
  mg.globalCompositeOperation = 'source-in';
  mg.fillStyle = '#ffffff';
  mg.fillRect(0, 0, 1024, 1024);
  ctx.markTex = R.texture('mark', mc);
  ctx.haloTex = R.texture('halo', haloCanvas(mark));
  ctx.titleTex = R.texture('title', titleCanvas('Growing', { size: 150, spacing: '0.12em', w: 1400, h: 240 }));
  ctx.taglineTex = R.texture('tagline', endLineCanvas('会记得，会接力，也会和你一起长大。', 'Run your own cat café.'));
  ctx.acts = [act2, act3, act4, act5, act6];
  ctx.overlayFx = [endCard];
  ctx.ringsTex = R.texture('rings', ringTextCanvas(RING_LINES));
  ctx.moreFx = [];
  ctx.shakes = [
    { t: 35.25, dur: 0.4, amp: 0.6, decay: 9 },
    { t: 36.0, dur: 1.4, amp: 2.4, decay: 3.2 },
    { t: 96.75, dur: 0.5, amp: 0.4, decay: 8 },
  ];
}
