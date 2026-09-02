/* Clowder AI — minimal PNG alpha reader (dev tool, zero dependencies).
 *
 * Decodes a non-interlaced 8-bit RGBA/RGB/grey PNG far enough to hand back the
 * alpha channel. Used by extract-tree-anchors.mjs so regenerating the painted
 * tree's twig anchors never depends on a native image library.
 */
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Undo the per-scanline PNG filters in place, returning raw samples. */
function unfilter(raw, width, height, bpp) {
  const stride = width * bpp;
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const type = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i += 1) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev ? prev[i] : 0;
      const c = prev && i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      if (type === 1) v += a;
      else if (type === 2) v += b;
      else if (type === 3) v += (a + b) >> 1;
      else if (type === 4) v += paeth(a, b, c);
      cur[i] = v & 0xff;
    }
  }
  return out;
}

/** Read `file` and return { width, height, alpha } with alpha as a Uint8Array. */
export function readAlpha(file) {
  const buf = readFileSync(file);
  let width = 0;
  let height = 0;
  let depth = 0;
  let colorType = 0;
  const idat = [];
  for (let off = 8; off + 8 <= buf.length; ) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const body = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      depth = body[8];
      colorType = body[9];
      if (depth !== 8) throw new Error(`${file}: only 8-bit PNGs are supported (got ${depth})`);
      if (body[12] !== 0) throw new Error(`${file}: interlaced PNGs are not supported`);
    } else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  const bpp = CHANNELS[colorType];
  if (!bpp) throw new Error(`${file}: unsupported color type ${colorType}`);
  const samples = unfilter(inflateSync(Buffer.concat(idat)), width, height, bpp);
  const alpha = new Uint8Array(width * height);
  const hasAlpha = colorType === 4 || colorType === 6;
  for (let i = 0; i < width * height; i += 1) alpha[i] = hasAlpha ? samples[i * bpp + bpp - 1] : 255;
  return { width, height, alpha };
}
