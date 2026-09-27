// Assembles the scene state for an instant and knows the draw order.
// Each element (camera, sky, tree, cast, fx) is a continuous function of film
// time, so acts hand over to each other without cuts in the underlying state.

import { cameraAt } from './camera.js';
import { skyAt } from './sky.js';
import { treeAt } from './tree.js';
import { castAt } from './cast.js';
import { fxAt } from './fx.js';
import { PBuf } from '../scene/particles.js';
import { FloatWriter } from '../gl.js';

export class Director {
  constructor(ctx) {
    this.ctx = ctx; // { timeline, cues, cats, world, forest, textures, ... }
    this.bufs = { bgx: new PBuf(), midBack: new PBuf(), mid: new PBuf(), fg: new PBuf() };
    this.shardW = new FloatWriter(1 << 14);
    this.shardWFg = new FloatWriter(1 << 12);
  }

  scene(t) {
    const ctx = this.ctx;
    for (const k in this.bufs) this.bufs[k].reset();
    const S = {
      t,
      parts: this.bufs,
      ridges: [],
      roots: [],
      crowns: [],
      canopies: [],
      bgxCrowns: [],
      bgxCanopies: [],
      cats: [],
      catsFront: [],
      humans: [],
      glass: [],
      shards: null,
      ribbonsUnder: [],
      ribbons: [],
      ribbonsFg: [],
      captions: [],
      overlays: [],
    };
    ctx._shardW = this.shardW.reset();
    ctx._shardWFg = this.shardWFg.reset();
    cameraAt(S, t, ctx);
    skyAt(S, t, ctx);
    treeAt(S, t, ctx);
    castAt(S, t, ctx);
    fxAt(S, t, ctx);
    if (this.shardW.n) S.shards = { a: this.shardW.a, n: this.shardW.n };
    if (this.shardWFg.n) S.shardsFg = { a: this.shardWFg.a, n: this.shardWFg.n };
    return S;
  }

  get draw() {
    return {
      bgx: (R, S, L, target) => {
        for (const c of S.bgxCrowns) R.drawBranches(S, c, L);
        for (const c of S.bgxCanopies) R.drawCanopy(S, c, L, target);
        R.drawParticles(S, S.parts.bgx.a, S.parts.bgx.n);
      },
      mid: (R, S, L, target) => {
        R.drawGround(S, S.ground);
        for (const r of S.roots) R.drawBranches(S, r, L);
        R.drawRibbons(S, S.ribbonsUnder);
        R.drawParticles(S, S.parts.midBack.a, S.parts.midBack.n);
        for (const c of S.crowns) R.drawBranches(S, c, L);
        for (const c of S.canopies) R.drawCanopy(S, c, L, target);
        for (const c of S.cats) R.drawSprite(S, c, L);
        for (const h of S.humans) R.drawHuman(S, h, L);
        for (const g of S.glass) R.drawGlass(S, g);
        for (const c of S.catsFront) R.drawSprite(S, c, L);
        if (S.shards) R.drawShards(S, S.shards.a, S.shards.n);
        R.drawParticles(S, S.parts.mid.a, S.parts.mid.n);
        R.drawRibbons(S, S.ribbons);
        for (const o of S.overlays) R.drawRings(S, o);
      },
      fg: (R, S, L) => {
        R.drawParticles(S, S.parts.fg.a, S.parts.fg.n);
        R.drawRibbons(S, S.ribbonsFg);
        if (S.shardsFg) R.drawShards(S, S.shardsFg.a, S.shardsFg.n);
      },
      overlay: (R, S) => {
        for (const c of S.captions) R.drawText(c.tex, c.rect, c);
      },
    };
  }
}
