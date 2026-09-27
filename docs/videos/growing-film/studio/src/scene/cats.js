// Canon cats as film actors. Sprites come from tools/prepare_cats.py; every pose
// keeps the canon's scale and foot anchor, so a cat can change pose in place.

export const CAT_CELL_UNITS = 0.0092; // world units per canon cell px (sitting cat ≈ 1.4)
export const CATS = ['ragdoll', 'maine', 'siamese'];
// role colours from the brand guide (Opus blue, Codex green, Gemini amber), linear-ish
export const CAT_GLOW = {
  ragdoll: [0.24, 0.5, 1.4],
  maine: [0.16, 1.1, 0.55],
  siamese: [1.4, 0.8, 0.12],
};

export class CatLibrary {
  constructor(renderer, base) {
    this.r = renderer;
    this.base = base;
    this.sprites = {};
    this.upscale = 3;
  }

  async load() {
    const m = await (await fetch(`${this.base}manifest.json`)).json();
    this.upscale = m.upscale;
    const names = Object.keys(m.sprites);
    await Promise.all(
      names.map(async (name) => {
        const img = new Image();
        img.src = `${this.base}${name}.png`;
        await img.decode();
        const info = m.sprites[name];
        this.sprites[name] = { tex: this.r.texture(`cat:${name}`, img), ax: info.ax, ay: info.ay, contact: info.contact };
      }),
    );
    return this;
  }

  get unit() {
    return CAT_CELL_UNITS / this.upscale;
  }

  /** Resolve a sprite; walk frames are "walk-1".."walk-4". */
  get(cat, pose) {
    const s = this.sprites[`${cat}-${pose}`];
    if (!s) throw new Error(`missing sprite ${cat}-${pose}`);
    return s;
  }
}

/**
 * Build a sprite draw item. `o` may hold: flip, z, alpha, scale, squash, rot,
 * sil, glowRim, pts, rimCol, ambient, keyCol.
 */
export function catItem(lib, cat, pose, x, y, o = {}) {
  const s = lib.get(cat, pose);
  const scale = o.scale ?? 1;
  return {
    tex: s.tex,
    ax: s.ax,
    ay: s.ay,
    unit: lib.unit * scale,
    x,
    y,
    z: o.z ?? 0,
    flip: !!o.flip,
    alpha: o.alpha ?? 1,
    squash: o.squash ?? [1, 1],
    rot: o.rot ?? 0,
    sil: o.sil ?? 0,
    glowRim: o.glowRim ?? 0,
    pts: o.pts,
    rimCol: o.rimCol,
    ambient: o.ambient,
    keyCol: o.keyCol,
    rimW: o.rimW,
  };
}

/** Walk frame for a cat moving at `speed` world units/s at time t (stride-synced). */
export function walkFrame(t, speed, stride = 0.62) {
  const cycles = (t * Math.abs(speed)) / stride;
  return `walk-${1 + (Math.floor(cycles * 4) % 4)}`;
}

/** Small "life": breathing squash for idle poses. */
export function breathe(t, seed = 0, amt = 0.012) {
  const s = Math.sin(t * 2.1 + seed * 5.0) * amt;
  return [1 - s * 0.5, 1 + s];
}

/** Pose-change pop: a quick squash & settle after a pose switch at t0. */
export function pop(t, t0, amt = 0.07) {
  if (t < t0 || t > t0 + 0.5) return [1, 1];
  const x = t - t0;
  const k = Math.exp(-x * 9) * Math.cos(x * 30) * amt;
  return [1 + k * 0.6, 1 - k];
}
