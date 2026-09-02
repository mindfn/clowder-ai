/* Clowder AI — Roadmap tree, engraved-plate art direction study.
 *
 * Same logical tree as roadmap-tree-data.js, drawn as a 19th-century botanical
 * plate instead of a storybook scene: ink line work carved with light hatching,
 * stipple for tonal mass, maturity encoded by engraving convention (solid /
 * half-hatched / open) rather than by colour, and the canon cats screened into
 * the same printed medium via halftone.
 *
 * Everything is deterministic from the data plus one seed.
 */
(function attachRoadmapPlate(global) {
  // The plate is a two-tone system — substrate and line — so it inverts with the site theme
  // instead of carrying its own palette.
  const theme = {
    ink: '#292524',
    paper: '#faf6f1',
    grain: '#8a7a6a',
    spark: '#ffffff',
    bloom: 'rgba(192,107,78,0.08)',
  };
  const INK = () => theme.ink;
  const PAPER = () => theme.paper;
  function setTheme(next) {
    Object.assign(theme, next);
  }

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

  const lerp = (a, b, k) => a + (b - a) * k;

  /** A tapered limb: centreline points carrying a half-width each. */
  function limbPath(rng, from, angle, len, w0, w1, bend, steps) {
    const pts = [];
    let { x, y } = from;
    let a = angle;
    for (let i = 0; i <= steps; i += 1) {
      pts.push({ x, y, w: lerp(w0, w1, i / steps) });
      a += bend / steps + (rng() - 0.5) * 0.06;
      x += Math.cos(a) * (len / steps);
      y += Math.sin(a) * (len / steps);
    }
    return { pts, angle: a, tip: { x, y } };
  }

  function ribbon(ctx, pts) {
    ctx.beginPath();
    for (let i = 0; i < pts.length; i += 1) {
      const p = pts[i];
      const q = pts[Math.min(pts.length - 1, i + 1)];
      const o = pts[Math.max(0, i - 1)];
      const d = Math.hypot(q.x - o.x, q.y - o.y) || 1;
      const nx = (-(q.y - o.y) / d) * p.w;
      const ny = ((q.x - o.x) / d) * p.w;
      if (i === 0) ctx.moveTo(p.x + nx, p.y + ny);
      else ctx.lineTo(p.x + nx, p.y + ny);
    }
    for (let i = pts.length - 1; i >= 0; i -= 1) {
      const p = pts[i];
      const q = pts[Math.min(pts.length - 1, i + 1)];
      const o = pts[Math.max(0, i - 1)];
      const d = Math.hypot(q.x - o.x, q.y - o.y) || 1;
      const nx = (-(q.y - o.y) / d) * p.w;
      const ny = ((q.x - o.x) / d) * p.w;
      ctx.lineTo(p.x - nx, p.y - ny);
    }
    ctx.closePath();
  }

  /** Thin wood is one stroke, not a filled shape: a ribbon that narrow turns into a wedge. */
  function twig(ctx, pts) {
    ctx.save();
    ctx.strokeStyle = INK();
    ctx.lineCap = 'round';
    for (let i = 0; i < pts.length - 1; i += 1) {
      ctx.lineWidth = Math.max(0.4, (pts[i].w + pts[i + 1].w) * 0.62);
      ctx.beginPath();
      ctx.moveTo(pts[i].x, pts[i].y);
      ctx.lineTo(pts[i + 1].x, pts[i + 1].y);
      ctx.stroke();
    }
    ctx.restore();
  }

  /** Engraving reads as light carved out of ink, so wood is filled then scored. */
  function carve(ctx, rng, pts) {
    if (pts[0].w < 2.6) {
      twig(ctx, pts);
      return;
    }
    ribbon(ctx, pts);
    ctx.fillStyle = INK();
    ctx.fill();
    if (pts[0].w < 5) return;
    ctx.save();
    ctx.clip();
    ctx.strokeStyle = PAPER();
    ctx.lineCap = 'round';
    // Bark is broken lines of uneven weight, not a comb: a continuous ruled stripe reads as metal.
    const lines = Math.max(3, Math.round(pts[0].w / 1.5));
    for (let i = 0; i < lines; i += 1) {
      const off = lerp(-0.86, 0.86, (i + 0.5) / lines) + (rng() - 0.5) * 0.16;
      const from = Math.floor(rng() * (pts.length * 0.4));
      const to = pts.length - Math.floor(rng() * (pts.length * 0.35));
      ctx.globalAlpha = (0.12 + 0.55 * (1 - Math.abs(off))) * (0.55 + rng() * 0.6);
      ctx.lineWidth = 0.4 + rng() * 0.9;
      ctx.beginPath();
      for (let j = from; j < to; j += 1) {
        const p = pts[j];
        const q = pts[Math.min(pts.length - 1, j + 1)];
        const o = pts[Math.max(0, j - 1)];
        const d = Math.hypot(q.x - o.x, q.y - o.y) || 1;
        const wob = off * (1 + Math.sin(j * 1.7 + i) * 0.09);
        const nx = (-(q.y - o.y) / d) * p.w * wob;
        const ny = ((q.x - o.x) / d) * p.w * wob;
        if (j === from) ctx.moveTo(p.x + nx, p.y + ny);
        else ctx.lineTo(p.x + nx, p.y + ny);
      }
      ctx.stroke();
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  /** Tonal mass without a single drawn leaf: density of dots, thinning outward. */
  function stipple(ctx, rng, cx, cy, radius, count, alpha) {
    ctx.fillStyle = INK();
    for (let i = 0; i < count; i += 1) {
      const t = rng() ** 0.62;
      const a = rng() * Math.PI * 2;
      const r = t * radius;
      const x = cx + Math.cos(a) * r * 1.16;
      const y = cy + Math.sin(a) * r * 0.86;
      ctx.globalAlpha = (alpha || 0.85) * (1 - t * 0.72);
      ctx.beginPath();
      ctx.arc(x, y, 0.45 + rng() * 0.95, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  /** Maturity by engraving convention: solid, half-hatched, open. */
  function fruit(ctx, x, y, r, status) {
    ctx.save();
    // Clear a little paper around each mark so maturity stays readable inside the stipple.
    ctx.fillStyle = PAPER();
    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    ctx.arc(x, y, r + 3.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = INK();
    ctx.fillStyle = INK();
    ctx.lineWidth = 1.1;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    if (status === 'ripe') {
      ctx.fill();
      ctx.globalAlpha = 0.55;
      ctx.strokeStyle = PAPER();
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(x - r * 0.3, y - r * 0.34, r * 0.42, Math.PI * 0.75, Math.PI * 1.6);
      ctx.stroke();
    } else if (status === 'green') {
      ctx.stroke();
      ctx.save();
      ctx.clip();
      ctx.lineWidth = 0.85;
      for (let i = -r; i <= r; i += 1.9) {
        ctx.beginPath();
        ctx.moveTo(x - r, y + i);
        ctx.lineTo(x + r, y + i - r * 0.9);
        ctx.stroke();
      }
      ctx.restore();
    } else {
      ctx.lineWidth = 0.9;
      ctx.stroke();
    }
    ctx.restore();
  }

  /** The canon cats, screened into the plate's medium instead of pasted onto it. */
  function halftone(ctx, img, x, y, height, cell) {
    const ratio = img.naturalWidth / img.naturalHeight;
    const w = Math.round(height * ratio);
    const off = document.createElement('canvas');
    off.width = w;
    off.height = Math.round(height);
    const octx = off.getContext('2d', { willReadFrequently: true });
    octx.drawImage(img, 0, 0, off.width, off.height);
    const px = octx.getImageData(0, 0, off.width, off.height).data;
    ctx.fillStyle = INK();
    for (let cy = 0; cy < off.height; cy += cell) {
      for (let cx = 0; cx < off.width; cx += cell) {
        let sum = 0;
        let hits = 0;
        for (let j = 0; j < cell; j += 1) {
          for (let i = 0; i < cell; i += 1) {
            const idx = ((cy + j) * off.width + cx + i) * 4;
            if (px[idx + 3] < 40) continue;
            sum += 1 - (px[idx] * 0.299 + px[idx + 1] * 0.587 + px[idx + 2] * 0.114) / 255;
            hits += 1;
          }
        }
        if (!hits) continue;
        const cover = (hits / (cell * cell)) * (0.28 + (sum / hits) * 0.95);
        const r = Math.min(cell * 0.62, cell * 0.62 * Math.sqrt(cover));
        if (r < 0.22) continue;
        ctx.beginPath();
        ctx.arc(x + cx + cell / 2, y + cy + cell / 2, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  global.ClowderRoadmapPlate = {
    theme,
    INK,
    PAPER,
    setTheme,
    mulberry32,
    limbPath,
    carve,
    twig,
    stipple,
    fruit,
    halftone,
    lerp,
  };
})(typeof window !== 'undefined' ? window : globalThis);
