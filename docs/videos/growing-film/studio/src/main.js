// Boot: load cues, cats and fonts, grow the world, then either play (preview)
// or render frames on demand for the capture tool.
//
// URL params: ?t=12.3 (still), ?render=1&from=0&to=122&fps=60&port=NNNN,
// ?stills=1,9.5,13 (PNG stills), ?scale=0.5 (preview resolution).

import { Renderer } from './renderer.js';
import { CatLibrary } from './scene/cats.js';
import { buildWorldTree } from './scene/world.js';
import { captionCanvas } from './scene/text.js';
import { Director } from './direction/index.js';
import { seedLight } from './direction/seed.js';
import { setupStaging } from './direction/staging.js';

const q = new URLSearchParams(location.search);
const W = 1920;
const H = 1080;

async function boot() {
  const status = (s) => {
    document.title = s;
    const el = document.getElementById('status');
    if (el) el.textContent = s;
  };
  status('loading');
  const timeline = await (await fetch('../timeline.json')).json();
  await document.fonts.load('300 50px "Songti SC"');
  await document.fonts.load('italic 25px Baskerville');
  const canvas = document.getElementById('c');
  const R = new Renderer(canvas, W, H);
  const cats = await new CatLibrary(R, '../build/cats/').load();
  const world = buildWorldTree();
  const captions = timeline.captions.map((c) => {
    const cv = captionCanvas(c.zh, c.en, c.style);
    return { ...c, tex: R.texture(`cap:${c.zh}`, cv) };
  });
  const ctx = { timeline, cues: timeline.cues, cats, world, captions, seedLight, renderer: R };
  await setupStaging(ctx);
  if (q.get('cam')) ctx.camOverride = q.get('cam').split(',').map(Number);
  const director = new Director(ctx);
  const draw = director.draw;
  const frame = (t) => {
    const S = director.scene(t);
    R.render(S, draw);
    return S;
  };
  window.__film = { frame, R, ctx, director };
  status('ready');

  const port = q.get('port');
  if (q.get('render')) {
    const fps = Number(q.get('fps') ?? 60);
    const from = Number(q.get('from') ?? 0);
    const to = Number(q.get('to') ?? 122);
    const gl = R.gl;
    const px = new Uint8Array(W * H * 4);
    const n0 = Math.round(from * fps);
    const n1 = Math.round(to * fps);
    for (let n = n0; n < n1; n++) {
      frame(n / fps);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
      await fetch(`http://127.0.0.1:${port}/frame/${n}`, { method: 'POST', body: px });
      if (n % 30 === 0) status(`frame ${n}/${n1}`);
    }
    await fetch(`http://127.0.0.1:${port}/done`, { method: 'POST', body: 'ok' });
    return;
  }
  if (q.get('stills')) {
    const ts = q.get('stills').split(',').map(Number);
    for (const t of ts) {
      frame(t);
      const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
      await fetch(`http://127.0.0.1:${port}/still/${t.toFixed(2)}`, { method: 'POST', body: blob });
    }
    await fetch(`http://127.0.0.1:${port}/done`, { method: 'POST', body: 'ok' });
    return;
  }
  // interactive preview
  let t0 = performance.now() - Number(q.get('t') ?? 0) * 1000;
  let paused = q.get('t') !== null;
  let tFix = Number(q.get('t') ?? 0);
  const loop = () => {
    const t = paused ? tFix : (performance.now() - t0) / 1000;
    frame(t % 122);
    status(`t=${t.toFixed(2)}`);
    requestAnimationFrame(loop);
  };
  window.addEventListener('keydown', (e) => {
    if (e.key === ' ') {
      paused = !paused;
      tFix = (performance.now() - t0) / 1000;
      t0 = performance.now() - tFix * 1000;
    }
  });
  loop();
}

boot().catch((e) => {
  console.error(e);
  document.title = `error: ${e.message}`;
  const port = q.get('port');
  if (port) fetch(`http://127.0.0.1:${port}/error`, { method: 'POST', body: String(e.stack || e) });
});
