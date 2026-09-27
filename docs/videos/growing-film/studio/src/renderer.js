// The frame pipeline. Layers: BG (sky + ridges, analytic DOF), BGX (distant trees
// and particles, pyramid DOF), MID (the world at the focal plane), FG (near
// grass/particles/shards, pyramid DOF). Then composite, god rays, bloom, grade,
// captions. Everything is drawn from a scene state S produced for one instant.

import { createGL, Program, Target, fullscreen, Instanced, Mesh, FloatWriter, blend, imageTexture } from './gl.js';
import { FULL_VS, SKY_FS, RIDGE_FS, GROUND_FS } from './shaders/env.js';
import { BRANCH_VS, BRANCH_FS, CANOPY_DENSITY_VS, CANOPY_DENSITY_FS, CANOPY_SHADE_FS, CLUMP_VS, CLUMP_FS } from './shaders/tree.js';
import { SPRITE_VS, SPRITE_FS, HUMAN_VS, HUMAN_FS, GLASS_VS, GLASS_FS, SHARD_VS, SHARD_FS } from './shaders/actors.js';
import { PART_VS, PART_FS, RIBBON_VS, RIBBON_FS, TEXT_VS, TEXT_FS, RINGS_FS } from './shaders/fx.js';
import { DOWN_FS, UP_FS, COPY_FS, COMPOSITE_FS, BRIGHT_FS, RAYSRC_FS, GODRAYS_FS, FINAL_FS } from './shaders/post.js';
import { emitBranches } from './tree.js';

const LEVELS = 7;

export class Renderer {
  constructor(canvas, W, H) {
    this.W = W;
    this.H = H;
    canvas.width = W;
    canvas.height = H;
    const gl = (this.gl = createGL(canvas));
    const P = (vs, fs, n) => new Program(gl, vs, fs, n);
    this.p = {
      sky: P(FULL_VS, SKY_FS, 'sky'),
      ridge: P(FULL_VS, RIDGE_FS, 'ridge'),
      ground: P(FULL_VS, GROUND_FS, 'ground'),
      branch: P(BRANCH_VS, BRANCH_FS, 'branch'),
      cdens: P(CANOPY_DENSITY_VS, CANOPY_DENSITY_FS, 'canopyDensity'),
      cshade: P(FULL_VS, CANOPY_SHADE_FS, 'canopyShade'),
      clump: P(CLUMP_VS, CLUMP_FS, 'clump'),
      sprite: P(SPRITE_VS, SPRITE_FS, 'sprite'),
      human: P(HUMAN_VS, HUMAN_FS, 'human'),
      glass: P(GLASS_VS, GLASS_FS, 'glass'),
      shard: P(SHARD_VS, SHARD_FS, 'shard'),
      part: P(PART_VS, PART_FS, 'particles'),
      ribbon: P(RIBBON_VS, RIBBON_FS, 'ribbon'),
      text: P(TEXT_VS, TEXT_FS, 'text'),
      rings: P(FULL_VS, RINGS_FS, 'rings'),
      down: P(FULL_VS, DOWN_FS, 'down'),
      up: P(FULL_VS, UP_FS, 'up'),
      copy: P(FULL_VS, COPY_FS, 'copy'),
      comp: P(FULL_VS, COMPOSITE_FS, 'composite'),
      bright: P(FULL_VS, BRIGHT_FS, 'bright'),
      raysrc: P(FULL_VS, RAYSRC_FS, 'raysrc'),
      rays: P(FULL_VS, GODRAYS_FS, 'godrays'),
      final: P(FULL_VS, FINAL_FS, 'final'),
    };
    this.full = fullscreen(gl);
    this.quad1 = new Instanced(gl, 0); // plain quad (per-draw uniforms)
    this.clumps = new Instanced(gl, 3);
    this.parts = new Instanced(gl, 3);
    this.branchMesh = new Mesh(gl, [3, 4, 4]);
    this.ribbonMesh = new Mesh(gl, [3, 4, 4]);
    this.shardMesh = new Mesh(gl, [3, 4]);
    this.fw = new FloatWriter(1 << 16);
    this.fw2 = new FloatWriter(1 << 14);
    const T = (w, h, f) => new Target(gl, w, h, f);
    this.t = {
      bg: T(W, H),
      bgx: T(W, H),
      mid: T(W, H),
      fg: T(W, H),
      dens: T(W, H),
      scene: T(W, H),
      raySrc: T(W >> 1, H >> 1),
      rays: T(W >> 1, H >> 1),
      light: T(W >> 1, H >> 1),
    };
    // pyramid: down[k] / up[k] at W>>k (k>=1); level 0 is the source itself
    this.down = [null];
    this.up = [null];
    for (let k = 1; k <= LEVELS; k++) {
      this.down.push(T(Math.max(1, W >> k), Math.max(1, H >> k)));
      this.up.push(T(Math.max(1, W >> k), Math.max(1, H >> k)));
    }
    this.blurOut = [T(W, H), T(W, H), T(W, H)];
    this.textures = new Map();
  }

  // ---------- camera ----------
  setCamera(cam) {
    const { W, H } = this;
    const fov = ((cam.fov ?? 34) * Math.PI) / 180;
    const tanH = Math.tan(fov / 2);
    const cz = cam.V / (2 * tanH);
    const f = H / 2 / tanH;
    this.cam = { x: cam.x, y: cam.y, z: cz, f, roll: cam.roll ?? 0, V: cam.V };
    this.camU = [cam.x, cam.y, cz, f];
  }
  pxAt(z) {
    return (this.cam.z - z) / this.cam.f;
  }
  /** world → screen px (origin bottom-left) */
  toScreen(x, y, z = 0) {
    const c = this.cam;
    const dz = c.z - z;
    let dx = x - c.x;
    let dy = y - c.y;
    const cr = Math.cos(-c.roll);
    const sr = Math.sin(-c.roll);
    const rx = cr * dx - sr * dy;
    const ry = sr * dx + cr * dy;
    return [this.W / 2 + (rx * c.f) / dz, this.H / 2 + (ry * c.f) / dz];
  }
  common(prog, S) {
    prog.set('uCam', this.camU);
    prog.set('uRes', [this.W, this.H]);
    prog.set('uRoll', this.cam.roll);
    prog.set('uTime', S.t);
  }

  // ---------- textures ----------
  texture(key, img) {
    let t = this.textures.get(key);
    if (!t && img) {
      t = imageTexture(this.gl, img);
      this.textures.set(key, t);
    }
    return t;
  }

  // ---------- passes ----------
  drawSky(S) {
    const gl = this.gl;
    const sky = S.sky;
    blend.off(gl);
    const p = this.p.sky.use();
    this.common(p, S);
    // horizon: where the sky plane's y=0 lands, plus an artistic offset
    const hz = this.toScreen(this.cam.x, 0, -3000)[1] + (sky.horizonShift ?? 0) * this.H;
    const sun = sky.sun ? this.toScreen(sky.sun.x, sky.sun.y, -3000) : [-9999, -9999];
    const moon = sky.moon ? this.toScreen(sky.moon.x, sky.moon.y, -3000) : [-9999, -9999];
    p.use({
      uZenith: sky.zenith,
      uMid: sky.mid,
      uHorizon: sky.horizon,
      uHorizonY: hz,
      uSun: [sun[0], sun[1], sky.sun?.size ?? 20, sky.sun?.i ?? 0],
      uSunColor: sky.sun?.col ?? [1, 1, 1],
      uMoon: [moon[0], moon[1], sky.moon?.size ?? 30, sky.moon?.i ?? 0],
      uStars: sky.stars ?? 0,
      uMilky: sky.milky ?? 0,
      uAurora: sky.aurora ?? 0,
      uClouds: sky.clouds ?? 0,
      uCloudLit: sky.cloudLit ?? [1, 0.8, 0.7],
      uCloudShade: sky.cloudShade ?? [0.3, 0.3, 0.4],
      uCloudTime: S.t,
    });
    this.full();
    this.sunScreen = sun;
  }

  drawRidges(S) {
    const gl = this.gl;
    blend.premul(gl);
    const p = this.p.ridge.use();
    this.common(p, S);
    const dof = S.dof || { inf: 0 };
    const sf = this.cam.z - (dof.focusZ ?? 0);
    for (const r of S.ridges || []) {
      if ((r.alpha ?? 1) <= 0) continue;
      const cocPx = dof.inf * Math.abs(1 - sf / Math.max(this.cam.z - r.z, 0.01));
      p.use({
        uBlur: cocPx * 0.5 * this.pxAt(r.z),
        uMist: r.mist ?? r.colBot,
        uZ: r.z,
        uBase: r.base,
        uAmp: r.amp,
        uFreq: r.freq,
        uSeed: r.seed,
        uTreeAmp: r.treeAmp ?? 0,
        uTreeFreq: r.treeFreq ?? 0.1,
        uAlpha: r.alpha ?? 1,
        uRim: r.rim ?? 0,
        uColTop: r.colTop,
        uColBot: r.colBot,
        uRimCol: r.rimCol ?? [1, 1, 1],
        uLights: r.lights ?? 0,
        uLightCol: r.lightCol ?? [1, 0.8, 0.5],
      });
      this.full();
    }
  }

  drawGround(S, g) {
    const gl = this.gl;
    blend.premul(gl);
    const p = this.p.ground.use();
    this.common(p, S);
    const gs = g.glows || [];
    const G = (i) => gs[i] || { x: 0, y: 0, r: 1, i: 0, col: [0, 0, 0] };
    p.use({
      uSoilTop: g.soilTop,
      uSoilDeep: g.soilDeep,
      uEdge: g.edge,
      uAmbient: g.ambient ?? [0, 0, 0],
      uStrata: g.strata ?? 1,
      uCut: g.cut ?? 1,
      uGlow0: [G(0).x, G(0).y, G(0).r, G(0).i],
      uGlow0Col: G(0).col,
      uGlow1: [G(1).x, G(1).y, G(1).r, G(1).i],
      uGlow1Col: G(1).col,
      uGlow2: [G(2).x, G(2).y, G(2).r, G(2).i],
      uGlow2Col: G(2).col,
      uLightTex: this.t.light,
      uLightAmt: g.lightAmt ?? 0,
      uRipple: g.ripple?.amt ?? 0,
      uRippleC: g.ripple?.c ?? [0, 0],
      uRippleR: g.ripple?.r ?? 0,
      uRippleCol: g.ripple?.col ?? [1, 1, 1],
    });
    this.full();
  }

  /** Branch strips for one tree part (crown or roots). */
  drawBranches(S, part, L) {
    const gl = this.gl;
    const tr = part.tree;
    const w = this.fw.reset();
    emitBranches(tr, w, {
      z: part.z ?? 0,
      ox: part.x ?? 0,
      oy: part.y ?? 0,
      scale: part.scale ?? 1,
      pxWorld: this.pxAt(part.z ?? 0),
      glow: part.glow,
      sway: part.sway,
    });
    if (!w.n) return;
    blend.premul(gl);
    const p = this.p.branch.use();
    this.common(p, S);
    const pt = (k) => (part.pts && part.pts[k]) || { x: 0, y: 0, r: 1, i: 0, col: [0, 0, 0] };
    p.use({
      uBark: part.bark ?? [0.09, 0.06, 0.045],
      uBarkDark: part.barkDark ?? [0.035, 0.025, 0.02],
      uBarkLit: part.barkLit ?? [0.2, 0.15, 0.1],
      uKeyCol: L.keyCol,
      uKeyDir: L.keyDir,
      uAmbient: L.ambient,
      uRimCol: part.rimCol ?? L.rimCol,
      uGlowA: part.glowA ?? [0.2, 0.5, 1.0],
      uGlowB: part.glowB ?? [0.2, 0.9, 0.6],
      uGlowC: part.glowC ?? [1.0, 0.7, 0.2],
      uBraid: part.braid ?? 0,
      uFlow: part.flow ?? 3,
      uPx: this.pxAt(part.z ?? 0),
      uKind: part.kind === 'roots' ? 1 : 0,
      uEmis: part.emis ?? 1,
      uVeins: part.veins ?? 0,
      uFade: part.alpha ?? 1,
      uYoung: part.young ?? 0,
      uPt0: [pt(0).x, pt(0).y, pt(0).r, pt(0).i],
      uPt0Col: pt(0).col,
      uPt1: [pt(1).x, pt(1).y, pt(1).r, pt(1).i],
      uPt1Col: pt(1).col,
    });
    this.branchMesh.draw(w.a, w.n);
  }

  /** Painterly canopy: leaf-edged clump stamps in painter's order. */
  drawCanopy(S, c, L) {
    const gl = this.gl;
    if (!c.clumps || !c.clumps.length) return;
    const n = c.clumps.length;
    const order = c.clumps.map((k, i) => [k.expo * 10 + k.y * 0.015 + k.hue * 0.3, i]).sort((a, b) => a[0] - b[0]);
    const a = new Float32Array(n * 12);
    let j = 0;
    for (const [, i] of order) {
      const k = c.clumps[i];
      a.set([k.x, k.y, k.r, c.z ?? 0, k.expo, k.hue, k.blossom ?? 0, k.alpha ?? 1, k.hue * 7.13 + i * 0.01, 0, 0, 0], j * 12);
      j++;
    }
    blend.premul(gl);
    const p = this.p.clump.use();
    this.common(p, S);
    const pal = c.pal;
    const pal2 = c.pal2 ?? pal;
    p.use({
      uLit: pal.lit,
      uMid: pal.mid,
      uShadow: pal.shadow,
      uRim: pal.rim,
      uLit2: pal2.lit,
      uMid2: pal2.mid,
      uShadow2: pal2.shadow,
      uRim2: pal2.rim,
      uFlipC: c.flipC ?? [0, 0],
      uFlipR: c.flipR ?? -10,
      uFlipGlow: c.flipGlow ?? 0,
      uKeyDir: L.keyDir,
      uKeyCol: L.keyCol,
      uAmbient: L.ambient,
      uPx: this.pxAt(c.z ?? 0),
      uLeafScale: c.leafScale ?? 2.2,
      uBacklit: c.backlit ?? 0,
      uBlossom: c.blossom ?? 0,
      uBlossomCol: c.blossomCol ?? [1, 0.8, 0.6],
      uBlossomCol2: c.blossomCol2 ?? [1, 0.6, 0.8],
      uFade: c.alpha ?? 1,
    });
    this.clumps.draw(a, n);
  }

  drawSprite(S, s, L) {
    const gl = this.gl;
    const tex = s.tex;
    if (!tex || (s.alpha ?? 1) <= 0) return;
    blend.premul(gl);
    const p = this.p.sprite.use();
    this.common(p, S);
    const sc = s.unit; // world units per sprite px
    const w = tex.w * sc;
    const h = tex.h * sc;
    const ax = (s.flip ? tex.w - s.ax : s.ax) * sc;
    const ay = (tex.h - s.ay) * sc; // anchor from bottom
    const left = s.x - ax;
    const bottom = s.y - ay;
    // key light direction in UV space (u right, v down); flip mirrors u
    let kx = L.keyDir[0];
    const ky = -L.keyDir[1];
    if (s.flip) kx = -kx;
    const kl = Math.hypot(kx, ky) || 1;
    const px = this.pxAt(s.z ?? 0);
    const screenPx = sc / px; // screen px per texel
    const lod = -0.25; // bias only: the hardware already picks the mip level
    const pt = (k) => (s.pts && s.pts[k]) || { x: 0, y: 0, r: 1, i: 0, col: [0, 0, 0] };
    p.use({
      uQuad: [left, bottom, w, h],
      uXf: [s.x, s.y, s.rot ?? 0, 0],
      uSquash: s.squash ?? [1, 1],
      uZ: s.z ?? 0,
      uFlip: s.flip ? 1 : 0,
      uTex: tex,
      uTexel: [1 / tex.w, 1 / tex.h],
      uAmbient: s.ambient ?? L.catAmbient ?? L.ambient,
      uKeyCol: s.keyCol ?? L.catKey ?? L.keyCol,
      uRimCol: s.rimCol ?? L.rimCol,
      uSilCol: s.silCol ?? [0.01, 0.012, 0.02],
      uKeyDirUV: [kx / kl, ky / kl],
      uRimW: s.rimW ?? 7,
      uAlpha: s.alpha ?? 1,
      uSil: s.sil ?? 0,
      uLod: lod,
      uGlowRim: s.glowRim ?? 0,
      uPt0: [pt(0).x, pt(0).y, pt(0).r, pt(0).i],
      uPt0Col: pt(0).col,
      uPt1: [pt(1).x, pt(1).y, pt(1).r, pt(1).i],
      uPt1Col: pt(1).col,
    });
    this.quad1.draw(new Float32Array(0), 1);
  }

  drawHuman(S, hmn, L) {
    const gl = this.gl;
    if ((hmn.alpha ?? 1) <= 0) return;
    blend.premul(gl);
    const p = this.p.human.use();
    this.common(p, S);
    const seg = new Float32Array(16 * 4);
    const rad = new Float32Array(16 * 2);
    hmn.segs.forEach((s, i) => {
      seg.set([s[0], s[1], s[2], s[3]], i * 4);
      rad.set([s[4], s[5]], i * 2);
    });
    const pt = hmn.pt || { x: 0, y: 0, r: 1, i: 0, col: [0, 0, 0] };
    p.use({
      uBox: hmn.box,
      uZ: hmn.z ?? 0,
      uSeg: seg,
      uSegR: rad,
      uSegN: hmn.segs.length,
      uHead: hmn.head,
      uBody: hmn.body ?? [0.012, 0.012, 0.02],
      uRimCol: hmn.rimCol ?? L.rimCol,
      uWarm: hmn.warm ?? [0, 0, 0],
      uKeyDir: L.keyDir,
      uAlpha: hmn.alpha ?? 1,
      uRimW: hmn.rimW ?? 0.07,
      uPt0: [pt.x, pt.y, pt.r, pt.i],
      uPt0Col: pt.col,
    });
    this.quad1.draw(new Float32Array(0), 1);
  }

  drawGlass(S, g) {
    const gl = this.gl;
    if ((g.alpha ?? 1) <= 0) return;
    blend.premul(gl);
    const p = this.p.glass.use();
    this.common(p, S);
    p.use({
      uBox: g.box,
      uZ: g.z ?? 0,
      uCorner: g.corner ?? 0.25,
      uAppear: g.appear ?? 1,
      uCrack: g.crack ?? 0,
      uImpact: g.impact ?? [g.box[0], g.box[1]],
      uFog: g.fog ?? 0,
      uAlpha: g.alpha ?? 1,
      uSeed: g.seed ?? 0,
      uFlash: g.flash ?? 0,
      uTint: g.tint ?? [0.6, 0.8, 1.0],
      uEdgeCol: g.edgeCol ?? [0.7, 0.85, 1.0],
      uCrackCol: g.crackCol ?? [0.9, 0.95, 1.0],
    });
    this.quad1.draw(new Float32Array(0), 1);
  }

  drawShards(S, data, n) {
    if (!n) return;
    const gl = this.gl;
    blend.premul(gl);
    const p = this.p.shard.use();
    this.common(p, S);
    p.use({ uEdgeCol: [0.75, 0.88, 1.0], uGlintCol: [1.6, 1.7, 1.9] });
    this.shardMesh.draw(data, n);
  }

  drawParticles(S, data, count) {
    if (!count) return;
    const gl = this.gl;
    blend.premul(gl);
    const p = this.p.part.use();
    this.common(p, S);
    this.parts.draw(data, count);
  }

  drawRibbons(S, ribbons) {
    const gl = this.gl;
    for (const rb of ribbons) {
      if (!rb.pts || rb.pts.length < 2 || (rb.alpha ?? 1) <= 0) continue;
      const w = this.fw2.reset();
      const pts = rb.pts;
      const m = pts.length;
      let v = 0;
      let prevL = null;
      let prevR = null;
      for (let i = 0; i < m; i++) {
        const a = pts[Math.max(0, i - 1)];
        const b = pts[Math.min(m - 1, i + 1)];
        let tx = b[0] - a[0];
        let ty = b[1] - a[1];
        const tl = Math.hypot(tx, ty) || 1;
        tx /= tl;
        ty /= tl;
        if (i > 0) v += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
        const width = (pts[i][2] ?? 1) * rb.width;
        const alpha = (pts[i][3] ?? 1) * (rb.alpha ?? 1);
        const z = rb.z ?? 0;
        const col = rb.color;
        const L = [pts[i][0] - ty * width, pts[i][1] + tx * width, z, -1, v, rb.core ?? 1, alpha, col[0], col[1], col[2], col[3] ?? 1];
        const R = [pts[i][0] + ty * width, pts[i][1] - tx * width, z, 1, v, rb.core ?? 1, alpha, col[0], col[1], col[2], col[3] ?? 1];
        if (prevL) {
          w.push(...prevL, ...prevR, ...L);
          w.push(...L, ...prevR, ...R);
        }
        prevL = L;
        prevR = R;
      }
      blend.premul(gl);
      const p = this.p.ribbon.use();
      this.common(p, S);
      p.use({
        uPulseFreq: rb.pulseFreq ?? 1,
        uPulseSpeed: rb.pulseSpeed ?? 0,
        uPulseAmt: rb.pulseAmt ?? 0,
        uPremul: rb.premul ? 1 : 0,
      });
      this.ribbonMesh.draw(w.a, w.n);
    }
  }

  drawRings(S, R) {
    const gl = this.gl;
    if (!R || R.amt <= 0) return;
    blend.premul(gl);
    const p = this.p.rings.use();
    this.common(p, S);
    p.use({
      uCenter: R.center,
      uScale: R.scale,
      uLit: R.lit,
      uAmt: R.amt,
      uSpin: R.spin ?? 0,
      uRings: R.rings,
      uText: R.textTex,
      uTextRows: R.rows,
      uWood: R.wood ?? [0.3, 0.17, 0.08],
      uLate: R.late ?? [0.12, 0.06, 0.03],
      uGlow: R.glow ?? [1.4, 0.8, 0.3],
      uGlow2: R.glow2 ?? [0.4, 0.9, 1.2],
    });
    this.full();
  }

  // ---------- pyramid blur ----------
  /** Variable-radius blur of target `src` (radius in px). Returns a texture holder. */
  blur(src, radius, outIdx) {
    const gl = this.gl;
    if (radius < 0.6) return src;
    const L = Math.min(LEVELS - 0.001, Math.log2(radius / 0.9));
    const N = Math.min(LEVELS, Math.ceil(L) + 1);
    blend.off(gl);
    const pd = this.p.down;
    let prev = src;
    for (let k = 1; k <= N; k++) {
      this.down[k].bind();
      pd.use({ uTex: prev, uTexel: [1 / prev.w, 1 / prev.h] });
      this.full();
      prev = this.down[k];
    }
    const pu = this.p.up;
    let coarse = this.down[N];
    for (let k = N - 1; k >= 0; k--) {
      const dst = k === 0 ? this.blurOut[outIdx] : this.up[k];
      const base = k === 0 ? src : this.down[k];
      const w = Math.min(1, Math.max(0, L - k + 1));
      dst.bind();
      pu.use({ uTex: coarse, uBase: base, uTexel: [1 / coarse.w, 1 / coarse.h], uW: w, uAdd: 0, uBaseW: 1 });
      this.full();
      coarse = dst;
    }
    return this.blurOut[outIdx];
  }

  bloom(src, thresh) {
    const gl = this.gl;
    blend.off(gl);
    this.down[1].bind();
    this.p.bright.use({ uTex: src, uThresh: thresh, uKnee: 0.5 });
    this.full();
    let prev = this.down[1];
    for (let k = 2; k <= LEVELS; k++) {
      this.down[k].bind();
      this.p.down.use({ uTex: prev, uTexel: [1 / prev.w, 1 / prev.h] });
      this.full();
      prev = this.down[k];
    }
    let coarse = this.down[LEVELS];
    for (let k = LEVELS - 1; k >= 1; k--) {
      this.up[k].bind();
      this.p.up.use({ uTex: coarse, uBase: this.down[k], uTexel: [1 / coarse.w, 1 / coarse.h], uW: 1, uAdd: 1, uBaseW: 1 });
      this.full();
      coarse = this.up[k];
    }
    return this.up[1];
  }

  // ---------- frame ----------
  render(S, draw) {
    const gl = this.gl;
    const { W, H } = this;
    this.setCamera(S.cam);
    const L = S.light;

    // BG: sky + ridges
    this.t.bg.bind([0, 0, 0, 1]);
    this.drawSky(S);
    this.drawRidges(S);
    // BGX: far trees and particles
    this.t.bgx.bind([0, 0, 0, 0]);
    draw.bgx?.(this, S, L, this.t.bgx);
    // MID
    this.t.mid.bind([0, 0, 0, 0]);
    draw.mid(this, S, L, this.t.mid);
    // FG
    this.t.fg.bind([0, 0, 0, 0]);
    draw.fg?.(this, S, L, this.t.fg);

    // depth of field
    const dof = S.dof || { inf: 0 };
    const sf = this.cam.z - (dof.focusZ ?? 0);
    const coc = (z) => dof.inf * Math.abs(1 - sf / Math.max(this.cam.z - z, 0.01));
    const bgx = this.blur(this.t.bgx, coc(dof.bgxZ ?? -60) * 0.5, 0);
    const fg = this.blur(this.t.fg, Math.min(coc(dof.fgZ ?? 2), 90) * 0.5, 1);
    const mid = dof.mid > 0.6 ? this.blur(this.t.mid, dof.mid, 2) : this.t.mid;

    // composite BG + BGX first (premul), then MID/FG
    this.t.scene.bind();
    blend.off(gl);
    this.p.copy.use({ uTex: this.t.bg, uGain: 1 });
    this.full();
    blend.premul(gl);
    this.p.copy.use({ uTex: bgx, uGain: 1 });
    this.full();
    this.p.copy.use({ uTex: mid, uGain: 1 });
    this.full();
    this.p.copy.use({ uTex: fg, uGain: 1 });
    this.full();

    // god rays
    const post = S.post;
    let raysTex = this.t.rays;
    if ((post.rays ?? 0) > 0 && this.sunScreen) {
      const su = [this.sunScreen[0] / W, this.sunScreen[1] / H];
      blend.off(gl);
      this.t.raySrc.bind();
      this.p.raysrc.use({ uBG: this.t.bg, uMID: this.t.mid, uFG: this.t.fg, uSun: su, uR: post.raysR ?? 0.45 });
      this.full();
      this.t.rays.bind();
      this.p.rays.use({ uTex: this.t.raySrc, uSun: su, uDensity: post.raysDensity ?? 0.9, uDecay: 0.965, uWeight: 0.05 });
      this.full();
    } else {
      this.t.rays.bind([0, 0, 0, 1]);
    }
    const bloomTex = this.bloom(this.t.scene, post.bloomThresh ?? 1.0);

    // final to screen
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, W, H);
    blend.off(gl);
    this.p.final.use({
      uScene: this.t.scene,
      uBloom: bloomTex,
      uRays: raysTex,
      uRes: [W, H],
      uTime: S.t,
      uExposure: post.exposure ?? 1,
      uBloomAmt: post.bloom ?? 0.25,
      uRaysAmt: post.rays ?? 0,
      uVignette: post.vignette ?? 0.35,
      uGrain: post.grain ?? 0.035,
      uSat: post.sat ?? 1,
      uContrast: post.contrast ?? 1,
      uFade: post.fade ?? 0,
      uFlash: post.flash ?? 0,
      uCA: post.ca ?? 1.2,
      uLift: post.lift ?? [0, 0, 0],
      uGain: post.gain ?? [1, 1, 1],
      uShadowTint: post.shadowTint ?? [0, 0, 0],
      uHighTint: post.highTint ?? [0, 0, 0],
      uGamma: post.gamma ?? 1,
    });
    this.full();
    // captions on top, in display space
    draw.overlay?.(this, S);
  }

  drawText(tex, rect, { alpha = 1, reveal = 1, blurLod = 0, soft = 0.15, tint = [1, 1, 1] } = {}) {
    const gl = this.gl;
    if (alpha <= 0) return;
    blend.premul(gl);
    const p = this.p.text.use();
    p.use({
      uRect: rect,
      uRes: [this.W, this.H],
      uTex: tex,
      uAlpha: alpha,
      uReveal: reveal * (1 + soft),
      uBlur: blurLod,
      uSoft: soft,
      uTint: tint,
    });
    this.quad1.draw(new Float32Array(0), 1);
  }
}
