/* Clowder AI — Roadmap plate: composition.
 *
 * Grows the logical roadmap (roadmap-tree-data.js) into an engraved specimen:
 * trunk, four limbs, their sub-limbs and one twig per feature, mirrored roots,
 * stipple canopy, halftoned cats. Returns the anchors the page needs to hang
 * its labels on, in plate coordinates.
 */
(function attachRoadmapPlateScene(global) {
  const P = global.ClowderRoadmapPlate;
  const W = 1200;
  const H = 1380;
  const GROUND = 958;
  const CX = 600;
  const D = Math.PI / 180;

  const LIMBS = [
    { id: 'capability', from: 0.99, angle: -122, len: 250, side: -1 },
    { id: 'life', from: 0.99, angle: -58, len: 250, side: 1 },
    { id: 'memory', from: 0.42, angle: -146, len: 232, side: -1 },
    { id: 'harness', from: 0.5, angle: -34, len: 232, side: 1 },
  ];
  const ROOTS = [145, 163, 17, 35];

  function pointAt(pts, k) {
    const i = Math.min(pts.length - 2, Math.floor(k * (pts.length - 1)));
    const f = k * (pts.length - 1) - i;
    const a = pts[i];
    const b = pts[i + 1];
    return { x: P.lerp(a.x, b.x, f), y: P.lerp(a.y, b.y, f), w: P.lerp(a.w, b.w, f) };
  }

  function paper(ctx, rng) {
    ctx.fillStyle = P.PAPER();
    ctx.fillRect(0, 0, W, H);
    for (let i = 0; i < 12; i += 1) {
      const x = rng() * W;
      const y = rng() * H;
      const r = 18 + rng() * 70;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, P.theme.bloom);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
    }
    for (let i = 0; i < 5200; i += 1) {
      ctx.globalAlpha = 0.03 + rng() * 0.07;
      ctx.fillStyle = rng() > 0.32 ? P.theme.grain : P.theme.spark;
      ctx.fillRect(rng() * W, rng() * H, 1, 1);
    }
    ctx.globalAlpha = 1;
  }

  /** The ground line exists before anything grows: it is the sheet, not the specimen. */
  function horizon(ctx) {
    ctx.strokeStyle = P.INK();
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(96, GROUND);
    for (let x = 96; x <= W - 96; x += 24) ctx.lineTo(x, GROUND + Math.sin(x * 0.021) * 1.6);
    ctx.stroke();
  }

  /** The seed is the opening subject: a mound of worked earth with one mark in it. */
  function seed(ctx, rng) {
    P.stipple(ctx, rng, CX, GROUND - 2, 26, 190, 0.5);
    ctx.save();
    ctx.fillStyle = P.INK();
    ctx.beginPath();
    ctx.ellipse(CX, GROUND - 7, 5.2, 3.6, -0.3, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function soil(ctx, rng) {
    ctx.strokeStyle = P.INK();
    ctx.lineWidth = 0.7;
    for (let i = 0; i < 210; i += 1) {
      const x = 96 + rng() * (W - 192);
      const y = GROUND + 4 + rng() ** 1.5 * 290;
      const len = 7 + rng() * 13;
      ctx.globalAlpha = 0.4 * (1 - (y - GROUND) / 340);
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + len * 0.6, y + len);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  /** Recursive sprigs. Two children per fork with unequal length reads as a grown tree;
   *  a fixed pair of equal twigs reads as a stamped motif. */
  function sprigs(ctx, rng, from, angle, len, w, depth) {
    if (depth <= 0 || len < 7) return;
    const forks = 3 + (rng() > 0.5 ? 1 : 0);
    let carrier = from;
    for (let i = 0; i < forks; i += 1) {
      // Each sprig leaves the parent a little further along and at its own angle; a symmetric
      // pair from a single point is what made these read as arrowheads.
      carrier = {
        x: carrier.x + Math.cos(angle * D) * len * 0.16,
        y: carrier.y + Math.sin(angle * D) * len * 0.16,
      };
      const spread = (i % 2 ? 1 : -1) * (16 + rng() * 30) + (rng() - 0.5) * 16;
      const l = len * (0.42 + rng() * 0.55);
      const t = P.limbPath(rng, carrier, (angle + spread) * D, l, w, w * 0.3, (rng() - 0.5) * 0.7, 4);
      P.twig(ctx, t.pts);
      if (rng() > 0.42) sprigs(ctx, rng, t.tip, angle + spread * 0.6, l * 0.6, w * 0.55, depth - 1);
    }
  }

  function build(ctx, rng, data) {
    const trunk = P.limbPath(rng, { x: CX, y: GROUND }, -92 * D, 430, 27, 10, 0.09, 10);
    const limbs = [];
    for (const spec of LIMBS) {
      const base = pointAt(trunk.pts, spec.from);
      const l1 = P.limbPath(
        rng,
        { x: base.x + spec.side * base.w * 0.5, y: base.y },
        spec.angle * D,
        spec.len,
        base.w * 0.66,
        4.2,
        spec.side * 0.5,
        9,
      );
      const branch = data.branches.find((b) => b.id === spec.id);
      const tips = [];
      branch.limbs.forEach((sub, j) => {
        const p = pointAt(l1.pts, [0.38, 0.66, 0.97][j]);
        const turn = (j === 1 ? 0 : j === 0 ? -30 : 26) * spec.side;
        const l2 = P.limbPath(
          rng,
          p,
          spec.angle * D + turn * D,
          118 + rng() * 30,
          p.w * 0.74,
          2.3,
          spec.side * 0.34,
          7,
        );
        sub.fruits.forEach((f, k) => {
          const q = pointAt(l2.pts, [0.42, 0.72, 0.98][k]);
          const l3 = P.limbPath(
            rng,
            q,
            spec.angle * D + (turn + (k === 1 ? 0 : k === 0 ? -34 : 30)) * D,
            54 + rng() * 26,
            Math.max(1.6, q.w * 0.68),
            0.9,
            (rng() - 0.5) * 0.5,
            5,
          );
          P.carve(ctx, rng, l3.pts);
          sprigs(ctx, rng, l3.tip, spec.angle + turn, 22, 0.75, 3);
          tips.push({ ...l3.tip, status: f.status, label: f.label });
        });
        P.carve(ctx, rng, l2.pts);
        sprigs(ctx, rng, pointAt(l2.pts, 0.45 + rng() * 0.3), spec.angle + turn - 44 * spec.side, 26, 0.95, 3);
      });
      P.carve(ctx, rng, l1.pts);
      // The reveal is a clip over one shared drawing, so each limb also carries the box it owns:
      // without it a limb's growing circle would uncover the limb above it.
      const pad = 96;
      const box = tips.reduce(
        (b, t) => ({
          x0: Math.min(b.x0, t.x - pad),
          y0: Math.min(b.y0, t.y - pad),
          x1: Math.max(b.x1, t.x + pad),
          y1: Math.max(b.y1, t.y + pad),
        }),
        { x0: base.x - 40, y0: base.y - 40, x1: base.x + 40, y1: base.y + 40 },
      );
      limbs.push({ id: spec.id, spec, path: l1, tips, label: branch.label, base: { x: base.x, y: base.y }, box });
    }
    P.carve(ctx, rng, trunk.pts);
    P.stipple(ctx, rng, CX, GROUND - 4, 34, 340, 0.5);
    return { trunk, limbs };
  }

  function roots(ctx, rng, data) {
    const out = [];
    data.roots.forEach((root, i) => {
      const a = ROOTS[i] * D;
      const r1 = P.limbPath(
        rng,
        { x: CX + Math.cos(a) * 12, y: GROUND + 4 },
        a,
        250,
        14,
        4,
        (a > Math.PI / 2 ? -1 : 1) * 0.3,
        8,
      );
      for (let j = 0; j < 3; j += 1) {
        const p = pointAt(r1.pts, 0.34 + j * 0.24);
        const side = j % 2 ? 1 : -1;
        const r2 = P.limbPath(rng, p, a + side * 36 * D, 74 + rng() * 34, p.w * 0.6, 1.2, side * 0.2, 5);
        P.carve(ctx, rng, r2.pts);
        sprigs(ctx, rng, r2.tip, a / D + side * 36, 20, 0.8, 3);
      }
      P.carve(ctx, rng, r1.pts);
      out.push({ tip: r1.tip, label: root.label });
    });
    return out;
  }

  /** One mass per limb, not one puff per twig: overlapping centres of uneven radius,
   *  seeded from the twigs and then blurred outward so the silhouette is irregular. */
  function canopy(ctx, rng, limbs) {
    for (const limb of limbs) {
      const box = limb.tips.reduce(
        (b, t) => ({
          x0: Math.min(b.x0, t.x),
          y0: Math.min(b.y0, t.y),
          x1: Math.max(b.x1, t.x),
          y1: Math.max(b.y1, t.y),
        }),
        { x0: 1e9, y0: 1e9, x1: -1e9, y1: -1e9 },
      );
      for (const tip of limb.tips) {
        P.stipple(ctx, rng, tip.x + (rng() - 0.5) * 14, tip.y - 4, 26 + rng() * 26, 120 + rng() * 110, 0.82);
      }
      for (let i = 0; i < 26; i += 1) {
        const t = limb.tips[Math.floor(rng() * limb.tips.length)];
        const cx = P.lerp(t.x, (box.x0 + box.x1) / 2, rng() * 0.55) + (rng() - 0.5) * 44;
        const cy = P.lerp(t.y, (box.y0 + box.y1) / 2, rng() * 0.5) + (rng() - 0.5) * 40;
        P.stipple(ctx, rng, cx, cy, 30 + rng() * 46, 90 + rng() * 120, 0.42);
      }
    }
  }

  function furniture(ctx) {
    ctx.strokeStyle = P.INK();
    ctx.globalAlpha = 0.85;
    ctx.lineWidth = 1.4;
    ctx.strokeRect(46, 46, W - 92, H - 92);
    ctx.lineWidth = 0.6;
    ctx.strokeRect(54, 54, W - 108, H - 108);
    ctx.globalAlpha = 1;
  }

  const ease = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : 1 - (1 - t) ** 2.4);
  const seg = (p, a, b) => Math.max(0, Math.min(1, (p - a) / (b - a)));

  // Growth order is the story: roots, then trunk, then the lower limbs, then the upper ones.
  // Each window closes on the beat that names it, so the text and the drawing agree.
  const PHASE = {
    memory: [0.34, 0.46],
    harness: [0.47, 0.59],
    capability: [0.6, 0.71],
    life: [0.72, 0.82],
  };
  const ROOTS_AT = [0.02, 0.14];
  const TRUNK_AT = [0.18, 0.32];

  function surface(dpr) {
    const c = document.createElement('canvas');
    c.width = W * dpr;
    c.height = H * dpr;
    const ctx = c.getContext('2d');
    ctx.scale(dpr, dpr);
    return { canvas: c, ctx };
  }

  /**
   * Draws the plate once into offscreen layers and returns compose(progress), which
   * re-reveals them through growing clip regions — the engraving draws itself outward
   * from the collar and from each limb's fork rather than fading in.
   */
  function render(canvas, data, opts) {
    const dpr = Math.min(2, global.devicePixelRatio || 1);
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    const view = canvas.getContext('2d');
    view.scale(dpr, dpr);

    const sheet = surface(dpr);
    paper(sheet.ctx, P.mulberry32(((opts && opts.seed) || 20260902) ^ 0x9e3779b9));
    furniture(sheet.ctx);
    horizon(sheet.ctx);
    seed(sheet.ctx, P.mulberry32(0x5eed));

    const art = surface(dpr);
    const rng = P.mulberry32((opts && opts.seed) || 20260902);
    soil(art.ctx, rng);
    const rootAnchors = roots(art.ctx, rng, data);
    const { limbs } = build(art.ctx, rng, data);
    canopy(art.ctx, rng, limbs);
    for (const limb of limbs) {
      for (const tip of limb.tips) P.fruit(art.ctx, tip.x, tip.y - 2, 6, tip.status);
    }

    // The camera reads the plate the way you would with a loupe: close on the part being drawn,
    // then pulled back at the end so the whole sheet lands as one image.
    const centre = (limb) => {
      const b = limb.tips.reduce(
        (a, t) => ({
          x0: Math.min(a.x0, t.x),
          y0: Math.min(a.y0, t.y),
          x1: Math.max(a.x1, t.x),
          y1: Math.max(a.y1, t.y),
        }),
        { x0: 1e9, y0: 1e9, x1: -1e9, y1: -1e9 },
      );
      return { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 };
    };
    const at = (id) => centre(limbs.find((l) => l.id === id));
    const KEYS = [
      { p: 0, x: CX, y: GROUND - 30, z: 1.72 },
      { p: 0.1, x: CX, y: GROUND + 120, z: 1.85 },
      { p: 0.28, x: CX, y: GROUND - 190, z: 1.8 },
      { p: 0.44, ...at('memory'), z: 1.85 },
      { p: 0.57, ...at('harness'), z: 1.85 },
      { p: 0.69, ...at('capability'), z: 1.85 },
      { p: 0.8, ...at('life'), z: 1.85 },
      { p: 0.88, x: CX, y: GROUND - 90, z: 1.6 },
      { p: 0.95, x: CX, y: H / 2, z: 1 },
      { p: 1, x: CX, y: H / 2, z: 1 },
    ];
    // Cats are rasterised from the shipped dot data (one sprite per pose, cached on first use),
    // then walked around the sheet with the story: gathered round the seed, walking between
    // limbs, standing up under whichever limb is being drawn.
    const screenedCats = global.ClowderPlateCats || {};
    const CAT_IDS = ['siamese', 'ragdoll', 'maine'];
    const catCache = new Map();
    // Fall back through the poses we would like to the ones the current sheet actually has.
    const FALLBACK = {
      reach: ['reach', 'stand', 'sit'],
      look: ['look', 'sit'],
      gaze: ['gaze', 'sit'],
      walk: ['walk', 'sit'],
    };
    function catSprite(i, pose) {
      const poses = screenedCats[CAT_IDS[i]];
      if (!poses) return null;
      const use = (FALLBACK[pose] || [pose, 'sit']).find((name) => poses[name]) || 'sit';
      const key = `${i}:${use}`;
      if (!catCache.has(key)) catCache.set(key, { ...P.screened(poses[use], dpr), pose: use });
      return catCache.get(key);
    }
    const under = (id, spread) => {
      const x = at(id).x;
      return spread.map((d) => Math.max(120, Math.min(W - 200, x + d)));
    };
    const HOME = [452, 664, 748];
    // Arrive before the beat and hold through it, so there is a stretch where the cats are
    // standing still under the limb rather than permanently in transit.
    const visit = (id, spread) => under(id, spread);
    const CAT_PLAN = [
      { p: 0, x: HOME },
      { p: 0.1, x: [438, 660, 752] },
      { p: 0.26, x: [428, 674, 764] },
      { p: 0.4, x: [...visit('memory', [-158, 26]), 700] },
      { p: 0.48, x: [...visit('memory', [-158, 26]), 700] },
      { p: 0.53, x: [520, ...visit('harness', [-42, 118])] },
      { p: 0.61, x: [520, ...visit('harness', [-42, 118])] },
      { p: 0.65, x: [...visit('capability', [-158, 26]), 690] },
      { p: 0.73, x: [...visit('capability', [-158, 26]), 690] },
      { p: 0.77, x: [530, ...visit('life', [-42, 118])] },
      { p: 0.84, x: [530, ...visit('life', [-42, 118])] },
      { p: 0.92, x: HOME },
      { p: 1, x: HOME },
    ];

    const smooth = (t) => t * t * (3 - 2 * t);
    function camera(p) {
      let i = 0;
      while (i < KEYS.length - 2 && p > KEYS[i + 1].p) i += 1;
      const a = KEYS[i];
      const b = KEYS[i + 1];
      const k = smooth(Math.max(0, Math.min(1, (p - a.p) / (b.p - a.p))));
      return { x: P.lerp(a.x, b.x, k), y: P.lerp(a.y, b.y, k), z: P.lerp(a.z, b.z, k) };
    }

    // Only profile poses may be mirrored: flipping a front-facing portrait just moves the
    // collar charm to the wrong side without turning the cat toward anything.
    const PROFILE = new Set(['walk', 'crouch', 'leap', 'look', 'gaze', 'reach']);

    /** Walking while they move, reaching up under the limb being drawn, watching otherwise. */
    function catPose(p, i) {
      const x = catX(p, i);
      const step = x - catX(Math.max(0, p - 0.008), i);
      if (Math.abs(step) > 0.9) return { pose: 'walk', dir: step > 0 ? 1 : -1 };
      if (p > 0.4 && p < 0.86) return { pose: 'reach', dir: x < CX ? -1 : 1 };
      if (p < 0.34) return { pose: 'look', dir: x < CX ? 1 : -1 };
      return { pose: 'gaze', dir: x < CX ? 1 : -1 };
    }

    function catX(p, i) {
      let k = 0;
      while (k < CAT_PLAN.length - 2 && p > CAT_PLAN[k + 1].p) k += 1;
      const a = CAT_PLAN[k];
      const b = CAT_PLAN[k + 1];
      const t = smooth(Math.max(0, Math.min(1, (p - a.p) / (b.p - a.p))));
      return P.lerp(a.x[i], b.x[i], t);
    }

    function compose(p, annotate) {
      const cam = camera(p);
      view.setTransform(1, 0, 0, 1, 0, 0);
      view.clearRect(0, 0, canvas.width, canvas.height);
      view.setTransform(dpr, 0, 0, dpr, 0, 0);
      view.translate(W / 2, H / 2);
      view.scale(cam.z, cam.z);
      view.translate(-cam.x, -cam.y);
      view.drawImage(sheet.canvas, 0, 0, W, H);

      const rRoot = ease(seg(p, ROOTS_AT[0], ROOTS_AT[1])) * 700;
      if (rRoot > 1) {
        view.save();
        view.beginPath();
        view.rect(0, GROUND - 2, W, H - GROUND + 2);
        view.clip();
        view.beginPath();
        view.arc(CX, GROUND, rRoot, 0, Math.PI * 2);
        view.clip();
        view.drawImage(art.canvas, 0, 0, W, H);
        view.restore();
      }

      const hTrunk = ease(seg(p, TRUNK_AT[0], TRUNK_AT[1])) * 470;
      const revealAbove = (own, shape) => {
        view.save();
        view.beginPath();
        view.rect(own.x0, own.y0, own.x1 - own.x0, Math.min(own.y1, GROUND + 3) - own.y0);
        view.clip();
        view.beginPath();
        shape();
        view.clip();
        view.drawImage(art.canvas, 0, 0, W, H);
        view.restore();
      };
      if (hTrunk > 1) {
        revealAbove({ x0: CX - 82, y0: 0, x1: CX + 82, y1: GROUND + 3 }, () =>
          view.rect(CX - 82, GROUND - hTrunk, 164, hTrunk + 6),
        );
      }
      for (const limb of limbs) {
        const [a, b] = PHASE[limb.id] || [0.4, 0.7];
        const r = ease(seg(p, a, b)) * 620;
        if (r > 1) revealAbove(limb.box, () => view.arc(limb.base.x, limb.base.y, r, 0, Math.PI * 2));
      }

      // The cats are not part of the growth — they are the ones planting it. They stand around
      // the seed, then move under whichever limb is being drawn, then gather again at the end.
      CAT_IDS.forEach((_, i) => {
        const { pose, dir } = catPose(p, i);
        const cat = catSprite(i, pose);
        if (!cat) return;
        const x = catX(p, i);
        view.save();
        view.translate(x, GROUND - cat.h);
        // Profile sprites are drawn facing left; mirror to turn one toward what it is looking at.
        if (dir > 0 && PROFILE.has(cat.pose)) {
          view.translate(cat.w, 0);
          view.scale(-1, 1);
        }
        view.drawImage(cat.canvas, 0, 0, cat.w, cat.h);
        view.restore();
      });
      if (annotate) annotate(view, cam);
      view.setTransform(dpr, 0, 0, dpr, 0, 0);
      return cam;
    }

    return {
      size: [W, H],
      ground: GROUND,
      compose,
      viewCtx: view,

      phase: PHASE,
      limbs: limbs.map((l) => {
        const outer = l.tips.reduce((a, b) => (l.spec.side < 0 ? (a.x < b.x ? a : b) : a.x > b.x ? a : b));
        return { id: l.id, label: l.label, side: l.spec.side, anchor: outer, done: (PHASE[l.id] || [0, 1])[1] };
      }),
      roots: rootAnchors,
      ctx: art.ctx,
    };
  }

  global.ClowderRoadmapPlateScene = { render, W, H, GROUND, CX };
})(typeof window !== 'undefined' ? window : globalThis);
