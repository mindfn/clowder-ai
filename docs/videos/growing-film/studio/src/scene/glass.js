// Glass cases and their shattering. Shards are Voronoi cells of the pane,
// thrown outward from the impact with tumbling (a fake 3D flip) and glints.

import { rng, clamp, smoothstep } from '../util.js';

function clipHalf(poly, nx, ny, c) {
  // keep points with nx*x + ny*y <= c
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const da = nx * a[0] + ny * a[1] - c;
    const db = nx * b[0] + ny * b[1] - c;
    if (da <= 0) out.push(a);
    if (da * db < 0) {
      const t = da / (da - db);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}

/** Voronoi shards of a box [cx, cy, hw, hh], local coordinates (relative to centre). */
export function makeShards(box, n, seed, impact) {
  const r = rng(seed);
  const [, , hw, hh] = box;
  const pts = [];
  for (let i = 0; i < n; i++) {
    // denser near the impact point
    let x;
    let y;
    if (i < n * 0.45 && impact) {
      const a = r() * Math.PI * 2;
      const d = Math.pow(r(), 1.6) * Math.min(hw, hh) * 1.1;
      x = clamp(impact[0] + Math.cos(a) * d, -hw, hw);
      y = clamp(impact[1] + Math.sin(a) * d, -hh, hh);
    } else {
      x = r.range(-hw, hw);
      y = r.range(-hh, hh);
    }
    pts.push([x, y]);
  }
  const shards = [];
  for (let i = 0; i < n; i++) {
    let poly = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]];
    const p = pts[i];
    for (let j = 0; j < n && poly.length; j++) {
      if (j === i) continue;
      const q = pts[j];
      const nx = q[0] - p[0];
      const ny = q[1] - p[1];
      const c = (nx * (p[0] + q[0])) / 2 + (ny * (p[1] + q[1])) / 2;
      poly = clipHalf(poly, nx, ny, c);
    }
    if (poly.length < 3) continue;
    let cx = 0;
    let cy = 0;
    for (const v of poly) {
      cx += v[0];
      cy += v[1];
    }
    cx /= poly.length;
    cy /= poly.length;
    const local = poly.map((v) => [v[0] - cx, v[1] - cy]);
    const dx = cx - (impact ? impact[0] : 0);
    const dy = cy - (impact ? impact[1] : 0);
    const dl = Math.hypot(dx, dy) || 1;
    const speed = 2.2 + 3.2 * r() + 1.5 / (0.4 + dl);
    shards.push({
      c: [cx, cy],
      poly: local,
      v: [(dx / dl) * speed + r.range(-0.6, 0.6), (dy / dl) * speed * 0.7 + r.range(0.4, 2.2)],
      vz: r.range(-0.5, 1.0) * (r() < 0.22 ? 5 : 1),
      spin: r.range(-4, 4),
      flip: r.range(2, 7),
      flipAxis: r() * Math.PI,
      seed: r(),
    });
  }
  return shards;
}

/**
 * Emit shard triangles at time `tau` after the break (already slowed by the
 * caller). Writes 7 floats per vertex: x, y, z, glint, alpha, edge, seed.
 */
export function emitShards(w, wFg, shards, box, tau, { fade = 1, gravity = -9, zBase = 0.05, fgZ = 1.2 } = {}) {
  const [bx, by] = box;
  for (const s of shards) {
    const x0 = bx + s.c[0] + s.v[0] * tau;
    const y0 = by + s.c[1] + s.v[1] * tau + 0.5 * gravity * tau * tau;
    const z = zBase + s.vz * tau;
    const ang = s.spin * tau;
    const fl = Math.cos(s.flip * tau + s.seed * 6);
    const ca = Math.cos(s.flipAxis);
    const sa = Math.sin(s.flipAxis);
    const glint = Math.pow(Math.max(0, Math.sin(s.flip * tau * 1.3 + s.seed * 20)), 24) * 2.5;
    const alpha = fade * (1 - smoothstep(1.6, 2.6, tau));
    if (alpha <= 0.002) continue;
    const target = z > fgZ ? wFg : w;
    const tf = (v) => {
      // squash along the flip axis to fake the shard turning in depth
      let px = v[0] * ca + v[1] * sa;
      const py = -v[0] * sa + v[1] * ca;
      px *= fl;
      const qx = px * ca - py * sa;
      const qy = px * sa + py * ca;
      const cr = Math.cos(ang);
      const sr = Math.sin(ang);
      return [x0 + qx * cr - qy * sr, y0 + qx * sr + qy * cr];
    };
    const cpos = tf([0, 0]);
    const P = s.poly.map(tf);
    for (let i = 0; i < P.length; i++) {
      const a = P[i];
      const b = P[(i + 1) % P.length];
      target.push(cpos[0], cpos[1], z, glint, alpha, 0, s.seed);
      target.push(a[0], a[1], z, glint, alpha, 1, s.seed);
      target.push(b[0], b[1], z, glint, alpha, 1, s.seed);
    }
  }
}
