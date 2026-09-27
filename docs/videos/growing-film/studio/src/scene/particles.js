// Particle emitters as pure functions of time: each particle's state is computed
// from its seed and age, so any frame can be rendered alone.

import { hash1, noise1, clamp, smoothstep, TAU } from '../util.js';

export const K = { glow: 0, sparkle: 1, leaf: 2, ring: 3, bokeh: 4, fruit: 5, lantern: 6, plane: 7, petal: 8, grass: 9 };

export class PBuf {
  constructor(n = 4096) {
    this.a = new Float32Array(n * 12);
    this.n = 0;
  }
  reset() {
    this.n = 0;
    return this;
  }
  push(x, y, z, size, r, g, b, a, rot, kind, aspect = 1, param = 0) {
    if ((this.n + 1) * 12 > this.a.length) {
      const b2 = new Float32Array(this.a.length * 2);
      b2.set(this.a);
      this.a = b2;
    }
    const o = this.n * 12;
    const A = this.a;
    A[o] = x; A[o + 1] = y; A[o + 2] = z; A[o + 3] = size;
    A[o + 4] = r; A[o + 5] = g; A[o + 6] = b; A[o + 7] = a;
    A[o + 8] = rot; A[o + 9] = kind; A[o + 10] = aspect; A[o + 11] = param;
    this.n++;
  }
}

const h = (i, k) => hash1(i * 13.37 + k * 71.13);

/** Floating motes / pollen in a box; drift with slow noise; twinkle. */
export function motes(buf, t, o) {
  const { n, x0, x1, y0, y1, z0 = 0, z1 = 0, size = 0.04, col = [1, 0.9, 0.7], alpha = 1, seed = 1, speed = 0.25, kind = K.glow } = o;
  if (alpha <= 0) return;
  for (let i = 0; i < n; i++) {
    const s = seed * 1000 + i;
    const px = h(s, 1);
    const py = h(s, 2);
    const pz = h(s, 3);
    const w = x1 - x0;
    const hh = y1 - y0;
    let x = x0 + ((px * w + t * speed * (0.3 + h(s, 4)) + noise1(t * 0.13 + s) * 1.5) % w + w) % w;
    let y = y0 + ((py * hh + t * speed * 0.35 * (h(s, 5) - 0.3) + noise1(t * 0.11 + s * 1.7) * 1.2) % hh + hh) % hh;
    const z = z0 + (z1 - z0) * pz;
    const tw = 0.55 + 0.45 * Math.sin(t * (1 + 2.5 * h(s, 6)) + h(s, 7) * TAU);
    const sz = size * (0.5 + h(s, 8));
    // fade near box edges so wrapping is invisible
    const ex = Math.min(x - x0, x1 - x) / (w * 0.08);
    const ey = Math.min(y - y0, y1 - y) / (hh * 0.08);
    const edge = clamp(Math.min(ex, ey));
    buf.push(x, y, z, sz, col[0], col[1], col[2], alpha * tw * edge, 0, kind);
  }
}

/** Fireflies: wandering, blinking. */
export function fireflies(buf, t, o) {
  const { n, x0, x1, y0, y1, z = 0, size = 0.06, col = [0.8, 1.0, 0.35], alpha = 1, seed = 3, zSpread = 0 } = o;
  if (alpha <= 0) return;
  for (let i = 0; i < n; i++) {
    const s = seed * 997 + i;
    const cx = x0 + (x1 - x0) * h(s, 1);
    const cy = y0 + (y1 - y0) * h(s, 2);
    const x = cx + noise1(t * 0.23 + s) * 2.2 + noise1(t * 0.07 + s * 3.1) * 3;
    const y = cy + noise1(t * 0.19 + s * 1.3) * 1.4;
    const period = 2.2 + 2.5 * h(s, 3);
    const ph = ((t + h(s, 4) * period) % period) / period;
    const blink = Math.pow(Math.sin(Math.PI * clamp(ph / 0.45)), 2) * 0.9 + 0.1;
    buf.push(x, y, z + (h(s, 5) - 0.5) * zSpread, size * (0.7 + 0.6 * h(s, 6)), col[0], col[1], col[2], alpha * blink, 0, K.glow);
  }
}

/** Burst of sparkles from a point at t0. */
export function burst(buf, t, t0, o) {
  const { x, y, z = 0, n = 40, speed = 2.5, life = 1.4, size = 0.08, col = [1, 0.85, 0.5], gravity = -0.6, seed = 5, kind = K.sparkle, spread = TAU, dir = 0, alpha = 1 } = o;
  const age = t - t0;
  if (age < 0) return;
  for (let i = 0; i < n; i++) {
    const s = seed * 331 + i;
    const L = life * (0.5 + 0.7 * h(s, 1));
    if (age > L) continue;
    const a = dir + (h(s, 2) - 0.5) * spread;
    const v = speed * (0.3 + 0.9 * h(s, 3));
    const drag = 1.8;
    const k = (1 - Math.exp(-drag * age)) / drag;
    const px = x + Math.cos(a) * v * k;
    const py = y + Math.sin(a) * v * k + 0.5 * gravity * age * age;
    const f = 1 - smoothstep(L * 0.4, L, age);
    const tw = 0.6 + 0.4 * Math.sin(age * 25 + s);
    buf.push(px, py, z, size * (0.5 + h(s, 4)) * (0.6 + 0.4 * f), col[0], col[1], col[2], alpha * f * tw, h(s, 5) * TAU, kind);
  }
}

/** Expanding ripple rings (flattened ellipses) from a point. */
export function ripples(buf, t, t0, o) {
  const { x, y, z = 0, count = 3, gap = 0.35, speed = 3.2, life = 2.2, col = [1, 0.8, 0.4], aspect = 0.28, alpha = 1, size0 = 0.05 } = o;
  for (let i = 0; i < count; i++) {
    const age = t - t0 - i * gap;
    if (age < 0 || age > life) continue;
    const r = size0 + speed * age * (1 - 0.18 * age / life);
    const f = 1 - smoothstep(0, life, age);
    buf.push(x, y, z, r, col[0], col[1], col[2], alpha * f * f, 0, K.ring, aspect);
  }
}

/** Falling leaves/petals from a region, fluttering. */
export function falling(buf, t, o) {
  const { n, x0, x1, ytop, ybot, z0 = 0, z1 = 0, size = 0.18, cols, alpha = 1, seed = 9, fall = 1.2, kind = K.leaf, t0 = -1e9, t1 = 1e9 } = o;
  if (alpha <= 0) return;
  const H = ytop - ybot;
  for (let i = 0; i < n; i++) {
    const s = seed * 577 + i;
    const period = H / (fall * (0.7 + 0.6 * h(s, 1)));
    const start = t0 + h(s, 2) * period;
    if (t < start || t > t1 + period) continue;
    const age = (t - start) % period;
    const cyc = Math.floor((t - start) / period);
    if (start + cyc * period > t1) continue;
    const y = ytop - age * (H / period);
    const sw = Math.sin(age * (1.6 + h(s, 3)) + h(s, 4) * TAU);
    const x = x0 + (x1 - x0) * h(s + cyc * 0.37, 5) + sw * 0.8 + age * 0.25;
    const col = cols[Math.floor(h(s, 6) * cols.length) % cols.length];
    const turn = Math.sin(age * 3.1 + s);
    const f = smoothstep(0, 0.5, age) * (1 - smoothstep(period - 0.6, period, age));
    buf.push(x, y, z0 + (z1 - z0) * h(s, 7), size * (0.6 + 0.6 * h(s, 8)), col[0], col[1], col[2], alpha * f, sw * 0.9 + h(s, 9) * 3, kind, 1, turn);
  }
}

/** Grass tufts along a ground function, swaying. */
export function grass(buf, t, o) {
  const { x0, x1, ground, z = 0, density = 14, height = 0.45, col = [0.1, 0.2, 0.08], alpha = 1, seed = 2, wind = 1, width = 0.09, tipCol } = o;
  const n = Math.floor((x1 - x0) * density);
  for (let i = 0; i < n; i++) {
    const s = seed * 7919 + i;
    const x = x0 + (i + h(s, 1)) / density;
    const gy = ground(x);
    const hh = height * (0.45 + 0.9 * h(s, 2)) * (0.6 + 0.4 * Math.abs(noise1(x * 0.35 + seed)));
    const sway = (Math.sin(t * 1.7 + x * 0.6 + h(s, 3) * 2) * 0.12 + noise1(t * 0.5 + x * 0.2) * 0.1) * wind + (h(s, 4) - 0.5) * 0.5;
    const cx = x + Math.sin(sway) * hh * 0.5;
    const cy = gy + Math.cos(sway) * hh * 0.5;
    const c = tipCol && h(s, 5) > 0.7 ? tipCol : col;
    const shade = 0.75 + 0.5 * h(s, 6);
    buf.push(cx, cy, z, hh * 0.5, c[0] * shade, c[1] * shade, c[2] * shade, alpha, -sway, K.grass, width, h(s, 7) - 0.5);
  }
}
