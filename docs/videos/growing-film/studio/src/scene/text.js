// Captions and inscriptions are typeset once with Canvas2D and uploaded as
// mipmapped textures (the mip bias doubles as a cheap blur-in).

const ZH = '"Songti SC", "STSong", serif';
const EN = 'Baskerville, "Hoefler Text", Georgia, serif';

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/** Caption card: Chinese line + English line, centred. */
export function captionCanvas(zh, en, style = 'line') {
  const W = 1800;
  const big = style === 'fruit';
  const zhSize = big ? 84 : 50;
  const enSize = big ? 30 : 25;
  const H = big ? 230 : 160;
  const c = canvas(W, H);
  const g = c.getContext('2d');
  g.textAlign = 'center';
  g.textBaseline = 'alphabetic';
  g.shadowColor = 'rgba(0,0,0,0.55)';
  g.shadowBlur = 22;
  g.fillStyle = '#fff8ee';
  g.font = `${big ? 400 : 300} ${zhSize}px ${ZH}`;
  g.letterSpacing = big ? '0.3em' : '0.14em';
  g.fillText(zh, W / 2 + (big ? zhSize * 0.15 : zhSize * 0.07), zhSize + 18);
  g.font = `italic 400 ${enSize}px ${EN}`;
  g.letterSpacing = '0.05em';
  g.fillStyle = 'rgba(255,246,232,0.78)';
  g.fillText(en, W / 2, zhSize + 30 + enSize * 1.55);
  return c;
}

export function titleCanvas(text, { size = 190, font = 'Didot, "Bodoni 72", serif', weight = 400, italic = false, spacing = '0.04em', w = 1600, h = 300 } = {}) {
  const c = canvas(w, h);
  const g = c.getContext('2d');
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = '#fffaf2';
  g.shadowColor = 'rgba(255,200,140,0.35)';
  g.shadowBlur = 30;
  g.font = `${italic ? 'italic ' : ''}${weight} ${size}px ${font}`;
  g.letterSpacing = spacing;
  g.fillText(text, w / 2, h / 2);
  return c;
}

/**
 * Ring inscriptions: one row per ring, text repeated around the ring with the
 * glyph size compensated so every ring reads at the same physical size.
 */
export function ringTextCanvas(lines, rowH = 64, width = 4096) {
  const rows = lines.length + 1;
  const c = canvas(width, rows * rowH);
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff';
  g.textBaseline = 'middle';
  for (let k = 1; k < rows; k++) {
    const text = lines[k - 1];
    // ring k has radius ~k+0.5; keep physical glyph size constant
    const size = Math.max(10, Math.min(46, (rowH * 0.62 * 3.2) / (k + 0.5)));
    g.font = `400 ${size}px ${ZH}`;
    g.letterSpacing = '0.08em';
    const unit = `${text}   ·   `;
    const uw = g.measureText(unit).width;
    const reps = Math.max(1, Math.floor(width / uw));
    const gap = (width - reps * uw) / reps;
    let x = 0;
    const yRow = k * rowH + rowH / 2; // row k spans texture v in [k, k+1)/rows; glyph tops face outward
    for (let i = 0; i < reps; i++) {
      g.fillText(unit, x, yRow);
      x += uw + gap;
    }
  }
  return c;
}
