#!/usr/bin/env node
// Export the picture's event tables for the sound design, so sound and picture
// share one source: build/events.json.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FLIGHTS, ROUTE, BOX_X } from '../studio/src/direction/act2.js';
import { FOREST, SPROUT_X } from '../studio/src/direction/act6.js';
import { LANTERN_X } from '../studio/src/direction/act4.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const timeline = JSON.parse(fs.readFileSync(path.join(ROOT, 'timeline.json'), 'utf8'));
const out = {
  cues: timeline.cues,
  flights: FLIGHTS.map(([t0, t1, from, to, arc]) => ({ t0, t1, from, to, arc })),
  route: ROUTE.map(([t0, t1, x0, x1, mode, target]) => ({ t0, t1, x0, x1, mode, target: target ?? null })),
  boxX: BOX_X,
  forest: FOREST.map(([x, s, at, seed]) => ({ x, s, at, seed })),
  sproutX: SPROUT_X,
  lanternX: LANTERN_X,
  lanternOn: LANTERN_X.map((_, k) => 60.0 + k * 0.4),
  lanternDim: [66.0, 66.75, 67.5, 68.25],
  lanternRelight: [2, 3, 4, 5].map((k) => 71.25 + (k - 2) * 0.35),
  rings: Array.from({ length: 12 }, (_, k) => +(45.75 + k * 0.36).toFixed(3)),
  heartbeats: [0.6, 2.1, 9.0, 10.5, 12.0, 13.5],
  knocks: [0, 1, 2, 3].map((k) => 29.75 + k * 0.14),
  glassAppear: [0, 1, 2].map((i) => 24.05 + i * 0.18),
};
fs.mkdirSync(path.join(ROOT, 'build'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'build', 'events.json'), JSON.stringify(out, null, 1));
console.log('events ->', path.join('build', 'events.json'), Object.keys(out).join(', '));
