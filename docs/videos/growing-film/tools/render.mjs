#!/usr/bin/env node
// Serve the studio, drive headless Chrome (GPU via ANGLE/Metal) and collect
// frames. No npm dependencies.
//
//   node tools/render.mjs stills 1,9.5,13.4          → out/stills/*.png
//   node tools/render.mjs video --from 0 --to 18 [--fps 60] [--out out/x.mp4]

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const args = process.argv.slice(2);
const mode = args[0];
const opt = (k, d) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : d;
};

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.css': 'text/css' };

let ffmpeg = null;
let frames = 0;
let chrome = null;
const started = Date.now();

function finish(code = 0) {
  if (chrome) chrome.kill('SIGKILL');
  const done = () => {
    const s = ((Date.now() - started) / 1000).toFixed(1);
    console.log(`done: ${frames} frames in ${s}s`);
    process.exit(code);
  };
  if (ffmpeg) {
    ffmpeg.stdin.end();
    ffmpeg.on('close', done);
  } else done();
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET') {
    const file = path.join(ROOT, decodeURIComponent(url.pathname));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
    return;
  }
  const chunks = [];
  req.on('data', (d) => chunks.push(d));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const p = url.pathname;
    res.writeHead(200, { 'access-control-allow-origin': '*' });
    if (p.startsWith('/frame/')) {
      frames++;
      const ok = ffmpeg.stdin.write(body);
      if (!ok) ffmpeg.stdin.once('drain', () => res.end('ok'));
      else res.end('ok');
      if (frames % 120 === 0) {
        const el = (Date.now() - started) / 1000;
        process.stdout.write(`  ${frames} frames, ${(frames / el).toFixed(1)} fps\n`);
      }
      return;
    }
    res.end('ok');
    if (p.startsWith('/still/')) {
      const t = p.slice(7);
      const dir = path.join(ROOT, 'out', 'stills');
      fs.mkdirSync(dir, { recursive: true });
      const f = path.join(dir, `still-${t.padStart(6, '0')}.png`);
      fs.writeFileSync(f, body);
      frames++;
      console.log(`still ${t} -> ${path.relative(ROOT, f)}`);
    } else if (p === '/done') {
      finish(0);
    } else if (p === '/error') {
      console.error(`page error:\n${body.toString()}`);
      finish(1);
    }
  });
});

server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  let query;
  if (mode === 'stills') {
    query = `stills=${args[1]}&port=${port}${opt('cam') ? `&cam=${opt('cam')}` : ''}${opt('dbg') ? `&dbg=${opt('dbg')}` : ''}`;
  } else if (mode === 'video') {
    const fps = Number(opt('fps', 60));
    const from = Number(opt('from', 0));
    const to = Number(opt('to', 122));
    const out = path.resolve(ROOT, opt('out', 'out/picture.mp4'));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const crf = opt('crf', '14');
    ffmpeg = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', '1920x1080', '-r', String(fps), '-i', '-', '-vf', 'vflip', '-c:v', 'libx264', '-preset', opt('preset', 'slow'), '-crf', crf, '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out], { stdio: ['pipe', 'inherit', 'inherit'] });
    query = `render=1&from=${from}&to=${to}&fps=${fps}&port=${port}`;
    console.log(`rendering ${from}s..${to}s @${fps} -> ${path.relative(ROOT, out)}`);
  } else {
    console.error('usage: render.mjs stills T1,T2 | video --from A --to B');
    process.exit(2);
  }
  const url = `http://127.0.0.1:${port}/studio/index.html?${query}`;
  chrome = spawn(CHROME, ['--headless=new', `--user-data-dir=/tmp/growing-film-chrome`, '--no-first-run', '--no-default-browser-check', '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--window-size=1920,1080', url], { stdio: 'ignore' });
  chrome.on('exit', (c) => {
    if (c && c !== 0) console.error(`chrome exited ${c}`);
  });
});

setTimeout(() => {
  console.error('timeout');
  finish(1);
}, Number(opt('timeout', 3600)) * 1000);
