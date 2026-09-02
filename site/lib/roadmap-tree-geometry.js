/* Clowder AI — Roadmap Tree: deterministic geometry
 *
 * Primitives (seeded PRNG, tapered curves, leaf scatter, growth progress) used by
 * roadmap-tree-skeleton.js to grow the botanical skeleton in a 1000×1200 viewBox.
 *
 * Growth timeline (G, in "chapters"):
 *   0 seed · 1 roots · 2 trunk · 3–6 one chapter per branch · 7 crown · 8 panorama
 */
(function attachRoadmapTreeGeometry(global) {
  const VIEW = { w: 1000, h: 1200, ground: 880, cx: 500 };
  const DEG = Math.PI / 180;

  function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let x = a;
      x = Math.imul(x ^ (x >>> 15), x | 1);
      x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
      return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
  }

  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  const lerp = (a, b, k) => a + (b - a) * k;

  /** Walk a curve: angle drifts toward `bendTo` with jitter; width tapers. */
  function curve(rng, from, angle, len, opts) {
    const n = opts.steps || 6;
    const pts = [];
    let x = from.x;
    let y = from.y;
    let a = angle;
    const step = len / n;
    for (let i = 0; i <= n; i += 1) {
      const k = i / n;
      pts.push({ x, y, w: lerp(opts.w0, opts.w1, k), k });
      const pull = ((opts.bendTo - a) * (opts.bend || 0.12)) / n;
      a += pull + (rng() - 0.5) * (opts.jitter || 10) * DEG;
      x += Math.cos(a) * step;
      y += Math.sin(a) * step;
    }
    return { pts, tipAngle: a };
  }

  function pointAt(pts, k) {
    const idx = Math.min(pts.length - 2, Math.floor(k * (pts.length - 1)));
    const f = k * (pts.length - 1) - idx;
    const a = pts[idx];
    const b = pts[idx + 1];
    return {
      x: lerp(a.x, b.x, f),
      y: lerp(a.y, b.y, f),
      w: lerp(a.w, b.w, f),
      angle: Math.atan2(b.y - a.y, b.x - a.x),
    };
  }

  function bboxOf(list) {
    const box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    for (const p of list) {
      box.x0 = Math.min(box.x0, p.x);
      box.y0 = Math.min(box.y0, p.y);
      box.x1 = Math.max(box.x1, p.x);
      box.y1 = Math.max(box.y1, p.y);
    }
    return box;
  }

  /** Scatter leaves along a branch; alternating sides, jittered angle and size. */
  function sprinkle(rng, leaves, host, pts, o) {
    for (let m = 0; m < o.count; m += 1) {
      const lp = pointAt(pts, o.from + m * o.step);
      const angle = lp.angle + (m % 2 === 0 ? -1 : 1) * (o.spread + rng() * o.jitter) * DEG;
      const size = o.size + rng() * o.sizeJitter;
      leaves.push({
        id: `${host}-leaf-${m}`,
        node: host,
        x: lp.x,
        y: lp.y,
        angle,
        size,
        color: o.color,
        g0: o.g0,
        g1: o.g1,
        phase: rng(),
      });
    }
  }

  /** Growth progress of any timed element for global timeline G. */
  function progress(el, G) {
    return clamp01((G - el.g0) / (el.g1 - el.g0));
  }

  global.ClowderRoadmapGeometry = { VIEW, DEG, mulberry32, curve, pointAt, bboxOf, sprinkle, progress, clamp01, lerp };
})(typeof window !== 'undefined' ? window : globalThis);
