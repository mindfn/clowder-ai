#!/usr/bin/env node
/* Build an unlabeled real-display-size QA sheet from 192x208 character rows. */
import sharp from 'sharp';

const [output, ...inputs] = process.argv.slice(2);
if (!output || inputs.length === 0) throw new Error('usage: build-character-contact-sheet.mjs output.png input...');

const PREVIEW_WIDTH = 59;
const PREVIEW_HEIGHT = 64;
const columns = Math.min(10, inputs.length);
const rows = Math.ceil(inputs.length / columns);
const cells = await Promise.all(
  inputs.map((input) =>
    sharp(input).resize({ width: PREVIEW_WIDTH, height: PREVIEW_HEIGHT, fit: 'fill' }).png().toBuffer(),
  ),
);

await sharp({
  create: {
    width: columns * PREVIEW_WIDTH,
    height: rows * PREVIEW_HEIGHT,
    channels: 4,
    background: { r: 246, g: 241, b: 231, alpha: 1 },
  },
})
  .composite(
    cells.map((input, index) => ({
      input,
      left: (index % columns) * PREVIEW_WIDTH,
      top: Math.floor(index / columns) * PREVIEW_HEIGHT,
    })),
  )
  .png()
  .toFile(output);

process.stdout.write(`${inputs.length} poses -> ${output}\n`);
