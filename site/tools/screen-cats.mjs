/* Clowder AI — screen the canon cats into plate dots (dev tool).
 *
 * The plate draws the cats as a halftone. Doing that in the browser means reading
 * the sprite back out of a canvas, which a page opened as a file:// URL is not
 * allowed to do — the cats silently vanish. So the screening happens here instead
 * and ships as plain dot data the page can draw in whatever the ink colour is.
 *
 * Two source shapes are accepted, so the house's 192x208 atlas convention and the
 * plate's tight-crop stills can come from one delivery:
 *   {cat}-{pose}-row.png   192x208 cells appended horizontally (F258 row-strips)
 *   {cat}-{pose}.png       a single tight-cropped sprite
 * Either way the cat's real bounding box is measured, so the foot anchor is derived
 * rather than assumed — cells are not baseline-aligned.
 *
 *   node site/tools/screen-cats.mjs
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPixels } from './png-alpha.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
// The character canon is the truth source now; site/assets/roadmap/cats is the old cut-outs.
const SPRITES = join(HERE, '../../docs/design/assets/character-canon/dist');
const OUT = join(HERE, '../lib/roadmap-plate-cats.js');
// Dot pitch, and the tone curve from coverage to dot radius. The first version had a 0.28
// floor under coverage and a square-root curve, which drove every opaque pixel to near-maximum
// radius: the interior of a pale cat went solid and any pose that reads through interior
// structure (curled, tucked, occluded) collapsed into a blob. Widening the range is what makes
// those poses legible — they were never too complex to draw, they were being flattened here.
const CELL = 2;
const TONE_FLOOR = 0.02;
const TONE_GAMMA = 0.6;
// One world scale per cat, fixed by its sitting height, so a cat that stands up gets taller
// instead of every pose being squashed into the same box.
const CATS = [
  { id: 'siamese', sit: 124 },
  { id: 'ragdoll', sit: 110 },
  { id: 'maine', sit: 134 },
];
// The canon has 38 actions per cat; the plate ships only the ones its story uses, because
// every extra pose is ~24KB of dot data on the page.
const POSES = [
  'sit',
  'walk',
  'look-down',
  'look-up',
  'reach',
  'stretch',
  'tail-up',
  'jump',
  'loaf',
  'sleep',
  'groom',
  'yawn',
];
const CELL_W = 192; // house atlas cell (packages/web/public/visible-cafe/skins/*/skin.json)
const CELL_H = 208;

/** Crop a source down to the ink that is actually in it. Cells carry padding; stills may too. */
function trim(src, box) {
  const [bx, by, bw, bh] = box;
  let x0 = bx + bw;
  let y0 = by + bh;
  let x1 = bx - 1;
  let y1 = by - 1;
  for (let y = by; y < by + bh; y += 1) {
    for (let x = bx; x < bx + bw; x += 1) {
      if (src.data[(y * src.width + x) * 4 + 3] < 40) continue;
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < x0) return null;
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** First cell of a row strip, or the whole image for a single sprite. */
function frameOf(src) {
  const isRow = src.height === CELL_H && src.width % CELL_W === 0;
  return trim(src, isRow ? [0, 0, CELL_W, CELL_H] : [0, 0, src.width, src.height]);
}

/** Box-sample the sprite at the dot pitch; darker and more opaque means a fatter dot. */
function screen(src, box, h) {
  const w = Math.round((box.w / box.h) * h);
  const dots = [];
  for (let cy = 0; cy < h; cy += CELL) {
    for (let cx = 0; cx < w; cx += CELL) {
      let ink = 0;
      let hits = 0;
      for (let j = 0; j < CELL; j += 1) {
        for (let i = 0; i < CELL; i += 1) {
          const sx = box.x + Math.floor(((cx + i) / w) * box.w);
          const sy = box.y + Math.floor(((cy + j) / h) * box.h);
          if (sx >= src.width || sy >= src.height) continue;
          const p = (sy * src.width + sx) * 4;
          if (src.data[p + 3] < 40) continue;
          ink += 1 - (src.data[p] * 0.299 + src.data[p + 1] * 0.587 + src.data[p + 2] * 0.114) / 255;
          hits += 1;
        }
      }
      if (!hits) continue;
      const cover = (hits / (CELL * CELL)) * (TONE_FLOOR + (ink / hits) * (1 - TONE_FLOOR));
      const r = Math.min(CELL * 0.62, CELL * 0.62 * cover ** TONE_GAMMA);
      if (r < 0.18) continue;
      dots.push(cx / CELL, cy / CELL, Math.round(r * 10) / 10);
    }
  }
  return { w, h, dots };
}

/**
 * Where the pose touches the world. Most poses stand on the ground, which is just the
 * bottom of the measured box. Some do not: a cat on a branch has its tail below its paws,
 * and a cat leaning on a surface touches it with its side. The surface itself never belongs
 * to the sprite — it is the consumer's tree trunk, or the edge of your browser window — so
 * the pose declares which edge is the contact and the consumer supplies the thing touched.
 *
 * Sidecar {cat}-{pose}.json, all optional:
 *   { "contact": { "side": "ground" | "ledge" | "wall-left" | "wall-right", "at": <px in cell> } }
 */
function contactOf(id, pose, box) {
  const file = join(SPRITES, `${id}-${pose}.json`);
  if (!existsSync(file)) return { side: 'ground' };
  const declared = JSON.parse(readFileSync(file, 'utf8')).contact;
  if (!declared || declared.side === 'ground') return { side: 'ground' };
  const axis = declared.side === 'ledge' ? box.y : box.x;
  const span = declared.side === 'ledge' ? box.h : box.w;
  return { side: declared.side, at: +(((declared.at ?? 0) - axis) / span).toFixed(4) };
}

/** Prefer a row strip, fall back to a single sprite. */
function source(id, pose) {
  for (const name of [`${id}-${pose}-row.png`, `${id}-${pose}.png`]) {
    const file = join(SPRITES, name);
    if (!existsSync(file)) continue;
    const src = readPixels(file);
    const box = frameOf(src);
    if (box) return { src, box };
  }
  return null;
}

const screened = CATS.map((cat) => {
  // World scale comes from the cat's measured height when sitting, not the file height:
  // in a 192x208 cell most of the file is padding.
  const anchor = source(cat.id, 'sit');
  if (!anchor) throw new Error(`${cat.id}: no sit sprite to scale from`);
  const scale = cat.sit / anchor.box.h;
  const poses = {};
  for (const pose of POSES) {
    const found = source(cat.id, pose);
    if (!found) continue;
    poses[pose] = {
      ...screen(found.src, found.box, Math.round(found.box.h * scale)),
      contact: contactOf(cat.id, pose, found.box),
    };
  }
  return { id: cat.id, poses };
});
const body = screened
  .map(
    (c) =>
      `  ${c.id}: {\n${Object.entries(c.poses)
        .map(
          ([pose, s]) =>
            `    '${pose}': { w: ${s.w}, h: ${s.h}, contact: ${JSON.stringify(s.contact)}, dots: [${s.dots.join(',')}] },`,
        )
        .join('\n')}\n  },`,
  )
  .join('\n');
writeFileSync(
  OUT,
  `/* Clowder AI — canon cats screened for the roadmap plate.
 *
 * GENERATED by site/tools/screen-cats.mjs from assets/roadmap/cats/*-sit.png.
 * Flat triples of x, y, radius in plate units. Shipped as data rather than screened
 * in the browser so the plate also works when the page is opened straight off disk.
 */
window.ClowderPlateCatCell = ${CELL};
window.ClowderPlateCats = {
${body}
};
`,
);
process.stdout.write(
  `${screened
    .map(
      (c) =>
        `${c.id}: ${Object.entries(c.poses)
          .map(([k, v]) => `${k}=${v.dots.length / 3}`)
          .join(' ')}`,
    )
    .join('\n')}\n-> ${OUT}\n`,
);
