#!/usr/bin/env node
/* Prepare one generated character cutout as a house-standard 192x208 row cell.
 *
 * Image generators sometimes paint a pale checkerboard instead of emitting alpha.
 * We remove only the pale, low-chroma region connected to the canvas edge. A dark
 * character outline therefore acts as a hard boundary: cream fur inside the outline
 * cannot be mistaken for background. Existing alpha is preserved.
 *
 * Usage:
 *   node site/tools/prepare-character-action.mjs input.png output.png maxW maxH [baseline]
 */
import sharp from 'sharp';

const [input, output, maxWidthArg, maxHeightArg, baselineArg = '197', cleanMasterOutput] = process.argv.slice(2);
if (!input || !output || !maxWidthArg || !maxHeightArg) {
  throw new Error('usage: prepare-character-action.mjs input output maxWidth maxHeight [baseline]');
}

const CELL_WIDTH = 192;
const CELL_HEIGHT = 208;
const maxWidth = Number(maxWidthArg);
const maxHeight = Number(maxHeightArg);
const baseline = Number(baselineArg);
if (![maxWidth, maxHeight, baseline].every(Number.isFinite)) throw new Error('sizes must be numbers');

const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const { width, height, channels } = info;
if (channels !== 4) throw new Error(`expected RGBA after ensureAlpha, got ${channels} channels`);

const count = width * height;
const exterior = new Uint8Array(count);
const queue = new Int32Array(count);
let head = 0;
let tail = 0;

function isRemovable(index) {
  const p = index * 4;
  const alpha = data[p + 3];
  if (alpha <= 5) return true;
  const r = data[p];
  const g = data[p + 1];
  const b = data[p + 2];
  const hi = Math.max(r, g, b);
  const lo = Math.min(r, g, b);
  // The fake transparency grid is near-white and nearly neutral. Requiring edge
  // connectivity protects similarly pale fur enclosed by the character outline.
  return lo >= 232 && hi - lo <= 18;
}

function seed(index) {
  if (exterior[index] || !isRemovable(index)) return;
  exterior[index] = 1;
  queue[tail++] = index;
}

for (let x = 0; x < width; x += 1) {
  seed(x);
  seed((height - 1) * width + x);
}
for (let y = 0; y < height; y += 1) {
  seed(y * width);
  seed(y * width + width - 1);
}

while (head < tail) {
  const index = queue[head++];
  const x = index % width;
  const y = Math.floor(index / width);
  if (x > 0) seed(index - 1);
  if (x + 1 < width) seed(index + 1);
  if (y > 0) seed(index - width);
  if (y + 1 < height) seed(index + width);
}

let x0 = width;
let y0 = height;
let x1 = -1;
let y1 = -1;
for (let i = 0; i < count; i += 1) {
  const p = i * 4;
  if (exterior[i]) {
    data[p] = 0;
    data[p + 1] = 0;
    data[p + 2] = 0;
    data[p + 3] = 0;
    continue;
  }
  if (data[p + 3] < 40) continue;
  const x = i % width;
  const y = Math.floor(i / width);
  x0 = Math.min(x0, x);
  y0 = Math.min(y0, y);
  x1 = Math.max(x1, x);
  y1 = Math.max(y1, y);
}
if (x1 < x0) throw new Error('no opaque subject found');

const cropWidth = x1 - x0 + 1;
const cropHeight = y1 - y0 + 1;
const croppedPipeline = sharp(data, { raw: { width, height, channels: 4 } })
  .extract({ left: x0, top: y0, width: cropWidth, height: cropHeight })
  .png();
const cleanMaster = await croppedPipeline.clone().toBuffer();
if (cleanMasterOutput) await sharp(cleanMaster).toFile(cleanMasterOutput);
const cropped = await sharp(cleanMaster)
  .resize({ width: maxWidth, height: maxHeight, fit: 'inside', withoutEnlargement: false })
  .png()
  .toBuffer({ resolveWithObject: true });

const left = Math.round((CELL_WIDTH - cropped.info.width) / 2);
const top = baseline - cropped.info.height + 1;
if (left < 0 || top < 0 || left + cropped.info.width > CELL_WIDTH || top + cropped.info.height > CELL_HEIGHT) {
  throw new Error(
    `prepared sprite ${cropped.info.width}x${cropped.info.height} does not fit ${CELL_WIDTH}x${CELL_HEIGHT}`,
  );
}

await sharp({
  create: { width: CELL_WIDTH, height: CELL_HEIGHT, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
})
  .composite([{ input: cropped.data, left, top }])
  .png()
  .toFile(output);

process.stdout.write(
  JSON.stringify({
    input,
    output,
    cleanMasterOutput,
    sourceBox: [x0, y0, cropWidth, cropHeight],
    cellBox: [left, top, cropped.info.width, cropped.info.height],
    baseline,
  }) + '\n',
);
