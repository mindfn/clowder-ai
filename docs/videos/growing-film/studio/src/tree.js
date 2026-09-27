// World tree: grown once by space colonisation, then *revealed* over time.
//
// Generation is deterministic (seeded). At render time a growth front D (path
// distance from the collar) decides what exists; radii follow the pipe model
// on the currently visible subtree, so a sapling is a thin whip and the old
// tree is massive, with no popping in between.

import { rng as makeRng, clamp, smoothstep, lerp } from './util.js';

function inUnion(puffs, x, y) {
  for (const p of puffs) {
    const dx = (x - p[0]) / p[2];
    const dy = (y - p[1]) / p[3];
    if (dx * dx + dy * dy <= 1) return true;
  }
  return false;
}

function sampleUnion(r, puffs, n) {
  let minx = Infinity;
  let maxx = -Infinity;
  let miny = Infinity;
  let maxy = -Infinity;
  for (const p of puffs) {
    minx = Math.min(minx, p[0] - p[2]);
    maxx = Math.max(maxx, p[0] + p[2]);
    miny = Math.min(miny, p[1] - p[3]);
    maxy = Math.max(maxy, p[1] + p[3]);
  }
  const out = [];
  let guard = 0;
  while (out.length < n && guard++ < n * 200) {
    const x = r.range(minx, maxx);
    const y = r.range(miny, maxy);
    if (inUnion(puffs, x, y)) out.push([x, y]);
  }
  return out;
}

/**
 * Space colonisation. `start` is a polyline (the trunk or taproot) that seeds
 * the node list; growth continues from every node.
 */
function colonise(
  r,
  state,
  { attractors, seg, influence, kill, iters, tropism, jitter, maxNodes, canSprout, maxBend = 0.6, maxLateral = 0.95, maxKids = 3 },
) {
  const { X, Y, P } = state;
  const firstNew = X.length;
  const nk = new Int32Array(maxNodes + 16);
  for (let i = 0; i < X.length; i++) if (P[i] >= 0) nk[P[i]]++;
  // direction a node was growing in (from its parent)
  const dirOf = (i) => {
    const p = P[i];
    if (p < 0) return [0, 1];
    const dx = X[i] - X[p];
    const dy = Y[i] - Y[p];
    const l = Math.hypot(dx, dy) || 1;
    return [dx / l, dy / l];
  };
  const alive = attractors.map((a) => [a[0], a[1], true]);
  const cell = influence;
  const grid = new Map();
  const key = (gx, gy) => gx * 100003 + gy;
  const addToGrid = (i) => {
    if (canSprout && i < firstNew && !canSprout(X[i], Y[i], i)) return;
    const k = key(Math.floor(X[i] / cell), Math.floor(Y[i] / cell));
    let b = grid.get(k);
    if (!b) grid.set(k, (b = []));
    b.push(i);
  };
  for (let i = 0; i < X.length; i++) addToGrid(i);

  for (let it = 0; it < iters && X.length < maxNodes; it++) {
    const acc = new Map();
    let any = false;
    for (const a of alive) {
      if (!a[2]) continue;
      const gx = Math.floor(a[0] / cell);
      const gy = Math.floor(a[1] / cell);
      let best = -1;
      let bd = influence * influence;
      for (let ox = -1; ox <= 1; ox++) {
        for (let oy = -1; oy <= 1; oy++) {
          const b = grid.get(key(gx + ox, gy + oy));
          if (!b) continue;
          for (const i of b) {
            const dx = a[0] - X[i];
            const dy = a[1] - Y[i];
            const d = dx * dx + dy * dy;
            if (d < bd) {
              bd = d;
              best = i;
            }
          }
        }
      }
      if (best < 0) continue;
      const d = Math.sqrt(bd) || 1;
      let v = acc.get(best);
      if (!v) acc.set(best, (v = [0, 0, 0]));
      v[0] += (a[0] - X[best]) / d;
      v[1] += (a[1] - Y[best]) / d;
      v[2]++;
      any = true;
    }
    if (!any) break;
    const born = [];
    for (const [i, v] of acc) {
      if (nk[i] >= maxKids) continue;
      let dx = v[0] / v[2] + tropism[0] + r.normal() * jitter;
      let dy = v[1] / v[2] + tropism[1] + r.normal() * jitter;
      const l = Math.hypot(dx, dy) || 1;
      dx /= l;
      dy /= l;
      // keep branching angles botanical: tips bend gently, laterals leave at
      // acute angles instead of combing out perpendicular to the limb
      if (P[i] >= 0) {
        const [px, py] = dirOf(i);
        const lim = nk[i] > 0 ? maxLateral : maxBend;
        const cross = px * dy - py * dx;
        const dot = px * dx + py * dy;
        const ang = Math.atan2(cross, dot);
        if (Math.abs(ang) > lim) {
          const a = Math.sign(ang) * lim;
          const c = Math.cos(a);
          const s2 = Math.sin(a);
          dx = px * c - py * s2;
          dy = px * s2 + py * c;
        }
      }
      const nx = X[i] + dx * seg;
      const ny = Y[i] + dy * seg;
      // refuse near-duplicates (oscillating growth between two attractors)
      let dup = false;
      const gx = Math.floor(nx / cell);
      const gy = Math.floor(ny / cell);
      const b = grid.get(key(gx, gy));
      if (b) {
        for (const j of b) {
          if (Math.abs(X[j] - nx) + Math.abs(Y[j] - ny) < seg * 0.5) {
            dup = true;
            break;
          }
        }
      }
      if (dup) continue;
      X.push(nx);
      Y.push(ny);
      P.push(i);
      nk[i]++;
      addToGrid(X.length - 1);
      born.push(X.length - 1);
    }
    if (!born.length) break;
    for (const a of alive) {
      if (!a[2]) continue;
      for (const i of born) {
        const dx = a[0] - X[i];
        const dy = a[1] - Y[i];
        if (dx * dx + dy * dy < kill * kill) {
          a[2] = false;
          break;
        }
      }
    }
  }
  return state;
}

/** Derived topology: children, path distance, chains (main axis first). */
function topology(X, Y, P) {
  const n = X.length;
  const kids = Array.from({ length: n }, () => []);
  for (let i = 1; i < n; i++) if (P[i] >= 0) kids[P[i]].push(i);
  const D = new Float32Array(n);
  const segL = new Float32Array(n);
  for (let i = 1; i < n; i++) {
    const p = P[i];
    if (p < 0) continue;
    segL[i] = Math.hypot(X[i] - X[p], Y[i] - Y[p]);
    D[i] = D[p] + segL[i];
  }
  // total subtree length (final) for choosing the main axis
  const sub = new Float32Array(n);
  for (let i = n - 1; i >= 0; i--) {
    for (const k of kids[i]) sub[i] += sub[k] + segL[k];
  }
  const maxDepthBelow = new Float32Array(n);
  for (let i = n - 1; i >= 0; i--) {
    for (const k of kids[i]) maxDepthBelow[i] = Math.max(maxDepthBelow[i], maxDepthBelow[k] + segL[k]);
  }
  // chains: follow the heaviest child
  const chains = [];
  const stack = [0];
  const order = new Int32Array(n);
  while (stack.length) {
    const s = stack.pop();
    const chain = [];
    if (P[s] >= 0) chain.push(P[s]); // start inside the parent so joins overlap
    let c = s;
    for (;;) {
      chain.push(c);
      const ks = kids[c];
      if (!ks.length) break;
      let heavy = ks[0];
      for (const k of ks) if (sub[k] + segL[k] > sub[heavy] + segL[heavy]) heavy = k;
      for (const k of ks) {
        if (k !== heavy) {
          order[k] = order[c] + 1;
          stack.push(k);
        }
      }
      order[heavy] = order[c];
      c = heavy;
    }
    chains.push(chain);
  }
  return { kids, D, segL, sub, chains, order, maxDepthBelow };
}

/**
 * Build a tree. `kind` = 'crown' (grows up) or 'roots' (grows down).
 * Returns an object with node arrays and a per-frame `state(front)` evaluator.
 */
export function buildTree(opts) {
  const r = makeRng(opts.seed ?? 7);
  const g = { X: [], Y: [], P: [] };
  opts.start.forEach((pt, i) => {
    g.X.push(pt[0]);
    g.Y.push(pt[1]);
    g.P.push(pt.length > 2 ? pt[2] : i - 1);
  });
  const phases = opts.phases ?? [opts];
  for (const ph of phases) {
    const attractors = sampleUnion(r, ph.puffs ?? opts.puffs, ph.attractors ?? 1200);
    colonise(r, g, {
      attractors,
      seg: ph.seg ?? 0.8,
      influence: ph.influence ?? 12,
      kill: ph.kill ?? 2,
      iters: ph.iters ?? 400,
      tropism: ph.tropism ?? opts.tropism ?? [0, 0.15],
      jitter: ph.jitter ?? opts.jitter ?? 0.12,
      maxNodes: ph.maxNodes ?? 8000,
      canSprout: ph.canSprout,
      maxBend: ph.maxBend,
      maxLateral: ph.maxLateral,
      maxKids: ph.maxKids,
    });
  }
  const topo = topology(g.X, g.Y, g.P);
  const n = g.X.length;
  const tree = {
    n,
    X: Float32Array.from(g.X),
    Y: Float32Array.from(g.Y),
    P: Int32Array.from(g.P),
    ...topo,
    maxD: Math.max(...topo.D),
    rTip: opts.rTip ?? 0.05,
    pipeK: opts.pipeK ?? 0.36,
    pipeExp: opts.pipeExp ?? 0.5,
    flare: opts.flare ?? 0,
    kind: opts.kind ?? 'crown',
    seed: opts.seed ?? 7,
  };
  // stable per-node randoms
  const rr = makeRng((opts.seed ?? 7) * 31 + 5);
  tree.rand = Float32Array.from({ length: n }, () => rr());
  // per-frame scratch
  tree.vis = new Float32Array(n); // visible fraction of the segment ending at node
  tree.subL = new Float32Array(n); // visible subtree length
  tree.rad = new Float32Array(n);
  return tree;
}

/**
 * Evaluate growth for front distance F (world units along the path) and a girth
 * multiplier. Fills tree.vis, tree.subL and tree.rad.
 */
export function evaluate(tree, F, girth = 1) {
  const { n, P, D, segL, kids, vis, subL, rad } = tree;
  for (let i = 0; i < n; i++) {
    const p = P[i];
    if (p < 0) {
      vis[i] = F > 0 ? 1 : 0;
      continue;
    }
    const d0 = D[p];
    vis[i] = segL[i] > 0 ? clamp((F - d0) / segL[i]) : 0;
  }
  for (let i = n - 1; i >= 0; i--) {
    let s = 0;
    for (const k of kids[i]) {
      if (vis[k] > 0) s += subL[k] + segL[k] * vis[k];
    }
    subL[i] = s;
  }
  const k = tree.pipeK * girth;
  for (let i = 0; i < n; i++) {
    if (vis[i] <= 0) {
      rad[i] = 0;
      continue;
    }
    // pipe model on the visible subtree plus a young-tip taper
    const L = subL[i];
    let r = tree.rTip + k * Math.pow(L, tree.pipeExp) * 0.1;
    const ahead = F - D[i];
    r *= 0.35 + 0.65 * smoothstep(0, 1.2, ahead);
    if (tree.flare && tree.kind === 'crown') {
      const y = tree.Y[i];
      r *= 1 + tree.flare * Math.exp(-Math.max(0, y) * 0.45);
    }
    rad[i] = r;
  }
}

/**
 * Emit triangles for every visible chain into writer `w`.
 * Vertex layout (9 floats): x, y, z, u(across -1..1), v(path distance), radius,
 * order, nodeRand, glowParam.
 */
export function emitBranches(tree, w, { z = 0, ox = 0, oy = 0, scale = 1, pxWorld = 0.01, glow = null, sway = null } = {}) {
  const { X, Y, rad, vis, chains, D, P, order, rand } = tree;
  const pts = [];
  for (const chain of chains) {
    pts.length = 0;
    for (let ci = 0; ci < chain.length; ci++) {
      const i = chain[ci];
      if (ci > 0 && vis[i] <= 0) break;
      let x = X[i];
      let y = Y[i];
      let rr = rad[i];
      if (ci > 0 && vis[i] < 1) {
        const p = P[i];
        x = lerp(X[p], X[i], vis[i]);
        y = lerp(Y[p], Y[i], vis[i]);
        rr = Math.max(rad[p] * 0.4, 0.0001);
      }
      if (ci === 0 && chain.length > 1 && P[chain[1]] === i) {
        // parent overlap point: use the child's radius, not the parent's
        rr = rad[chain[1]] || rr;
      }
      if (sway) {
        const s = sway(x, y, D[i], order[i]);
        x += s[0];
        y += s[1];
      }
      pts.push([ox + x * scale, oy + y * scale, rr * scale, D[i], order[i], rand[i]]);
    }
    if (pts.length < 2) continue;
    // chaikin-smooth the polyline once for rounder bends
    const sm = [pts[0]];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      if (i > 0) sm.push(a.map((v, k) => v * 0.75 + b[k] * 0.25));
      if (i < pts.length - 2) sm.push(a.map((v, k) => v * 0.25 + b[k] * 0.75));
    }
    sm.push(pts[pts.length - 1]);
    const m = sm.length;
    let prevL = null;
    let prevR = null;
    for (let i = 0; i < m; i++) {
      const a = sm[Math.max(0, i - 1)];
      const b = sm[Math.min(m - 1, i + 1)];
      let tx = b[0] - a[0];
      let ty = b[1] - a[1];
      const tl = Math.hypot(tx, ty) || 1;
      tx /= tl;
      ty /= tl;
      const p = sm[i];
      const rw = p[2] + pxWorld * 1.5; // expand for edge AA
      const nx = -ty;
      const ny = tx;
      const g = glow ? glow(p) : 0;
      const L = [p[0] + nx * rw, p[1] + ny * rw, z, -1, p[3], p[2], p[4], p[5], g];
      const R = [p[0] - nx * rw, p[1] - ny * rw, z, 1, p[3], p[2], p[4], p[5], g];
      if (prevL) {
        w.push(...prevL, ...prevR, ...L);
        w.push(...L, ...prevR, ...R);
      }
      prevL = L;
      prevR = R;
    }
  }
}

/** Nodes that currently carry foliage, with clump radius (0 when bare). */
export function foliage(tree, F, { minL = 0, maxL = 14, size = 2.2, grow = 1.2 } = {}) {
  const out = [];
  const { n, X, Y, vis, subL, D, rand } = tree;
  for (let i = 1; i < n; i++) {
    if (vis[i] < 1) continue;
    const young = smoothstep(0, grow, F - D[i]);
    const outer = 1 - smoothstep(minL, maxL, subL[i]);
    const f = young * outer;
    if (f <= 0.01) continue;
    out.push({ i, x: X[i], y: Y[i], r: size * f * (0.65 + 0.7 * rand[i]), rand: rand[i] });
  }
  return out;
}
