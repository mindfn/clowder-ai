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
  const H = 1560;
  const GROUND = 1015;
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
    ctx.fillStyle = P.PAPER;
    ctx.fillRect(0, 0, W, H);
    for (let i = 0; i < 12; i += 1) {
      const x = rng() * W;
      const y = rng() * H;
      const r = 18 + rng() * 70;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, 'rgba(132,102,58,0.10)');
      g.addColorStop(1, 'rgba(132,102,58,0)');
      ctx.fillStyle = g;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
    }
    for (let i = 0; i < 5200; i += 1) {
      ctx.globalAlpha = 0.03 + rng() * 0.07;
      ctx.fillStyle = rng() > 0.32 ? '#6b573a' : '#fffaf0';
      ctx.fillRect(rng() * W, rng() * H, 1, 1);
    }
    ctx.globalAlpha = 1;
  }

  function soil(ctx, rng) {
    ctx.strokeStyle = P.INK;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(96, GROUND);
    for (let x = 96; x <= W - 96; x += 24) ctx.lineTo(x, GROUND + Math.sin(x * 0.021) * 1.6);
    ctx.stroke();
    ctx.lineWidth = 0.7;
    for (let i = 0; i < 210; i += 1) {
      const x = 96 + rng() * (W - 192);
      const y = GROUND + 4 + rng() ** 1.5 * 300;
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
      limbs.push({ id: spec.id, spec, path: l1, tips, label: branch.label });
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
    ctx.strokeStyle = P.INK;
    ctx.globalAlpha = 0.85;
    ctx.lineWidth = 1.4;
    ctx.strokeRect(46, 46, W - 92, H - 92);
    ctx.lineWidth = 0.6;
    ctx.strokeRect(54, 54, W - 108, H - 108);
    ctx.globalAlpha = 1;
  }

  function render(canvas, data, opts) {
    const dpr = Math.min(2, global.devicePixelRatio || 1);
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    const rng = P.mulberry32((opts && opts.seed) || 20260902);
    paper(ctx, rng);
    furniture(ctx);
    soil(ctx, rng);
    const rootAnchors = roots(ctx, rng, data);
    const { limbs } = build(ctx, rng, data);
    canopy(ctx, rng, limbs);
    for (const limb of limbs) {
      for (const tip of limb.tips) P.fruit(ctx, tip.x, tip.y - 2, 6, tip.status);
    }
    return {
      size: [W, H],
      ground: GROUND,
      limbs: limbs.map((l) => {
        const outer = l.tips.reduce((a, b) => (l.spec.side < 0 ? (a.x < b.x ? a : b) : a.x > b.x ? a : b));
        return { id: l.id, label: l.label, side: l.spec.side, anchor: outer };
      }),
      roots: rootAnchors,
      ctx,
    };
  }

  global.ClowderRoadmapPlateScene = { render, W, H, GROUND, CX };
})(typeof window !== 'undefined' ? window : globalThis);
