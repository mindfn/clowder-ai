#!/usr/bin/env node
/* Remove a temporary chroma guide from an imagegen sprite edit.
 *
 * The guide exists only to keep an interaction pose stable while imagegen edits
 * the scene. It must never reach a consumer asset. For a left-wall guide, the
 * green region tells us the guide's right edge; every pixel through that column
 * is cleared so dark anti-aliasing around the guide cannot leak into the sprite.
 *
 * Usage: node site/tools/remove-sprite-guide.mjs input.png output.png
 */
import sharp from 'sharp';

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  throw new Error('usage: remove-sprite-guide.mjs input.png output.png');
}

const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
let guideRight = -1;
for (let y = 0; y < info.height; y += 1) {
  for (let x = 0; x < info.width; x += 1) {
    const offset = (y * info.width + x) * 4;
    const r = data[offset];
    const g = data[offset + 1];
    const b = data[offset + 2];
    if (g >= 170 && g - r >= 70 && g - b >= 70) guideRight = Math.max(guideRight, x);
  }
}
if (guideRight < 0) throw new Error('no green guide found');
const clearThrough = Math.min(info.width - 1, guideRight + 4);

for (let y = 0; y < info.height; y += 1) {
  for (let x = 0; x <= clearThrough; x += 1) {
    const offset = (y * info.width + x) * 4;
    data[offset] = 0;
    data[offset + 1] = 0;
    data[offset + 2] = 0;
    data[offset + 3] = 0;
  }
}

await sharp(data, { raw: info }).png().toFile(output);
process.stdout.write(`${input} -> ${output} (cleared x <= ${clearThrough})\n`);
