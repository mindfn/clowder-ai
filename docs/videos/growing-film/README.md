# Growing — animated film (studio source)

A ~2-minute animated film for the **Growing** narrative (issue #1403 and the public
co-creation brief), made entirely from code: a WebGL2 multiplane renderer draws every
frame as a pure function of time; the score and sound design are synthesised and
sampled from a shared cue sheet so picture and sound hit together.

It follows the brief's six acts and its honesty rule: the fable layer carries the
invisible relationships and the future; nothing on screen claims a shipped capability.
The last act is captioned as belief ("我们相信"), not as product.

## Six acts (80 BPM, 1 bar = 3 s, 40 bars)

| Act | Bars | Time | Picture | Sound |
|---|---|---|---|---|
| 一 种子 | 1–6 | 0:00–0:18 | Night. A pulsing star falls, slows into a glowing seed, lands between a kneeling person and three cats; ripple through the soil; sprout; Ragdoll pats it; dawn begins. | Heartbeat, wind; celesta "growing" motif (F♯–G–A); soft strings; harp at landing; flute. |
| 二 疯长 | 7–12 | 0:18–0:36 | Time-lapse: days flicker, the tree shoots up, leaves renew overnight. Each cat ends up in its own glass case; the person runs between them throwing paper planes. Pressure builds; a crack. | Harp ostinato, staccato horns, clock ticks, timpani, riser; hard stop, a lone crack. |
| 三 扎根 | 13–18 | 0:36–0:54 | The glass shatters in slow motion. The camera dives through the soil: three coloured streams (blue / green / amber — the cats' role colours) run into one root network that lights up. Into the trunk: rings light outward, inscribed with real history. | Brass hit + taiko on the shatter; low strings; the horn states the theme; root pulses; ring chimes. |
| 四 托付 | 19–25 | 0:54–1:15 | Dusk. The person sets down a lantern and walks away; Ragdoll waves. The cats relay a light along a limb. Maine Coon reaches for a prop root that holds up its own limb — the dependency chain lights, lanterns (promises) dim one by one; the paw stops; a new tendril offers another path; lanterns relight. | Flute over strings; handoff pings; tension cluster, descending celesta per dimmed lantern; silence + heartbeat; harp glissando into warm resolution. |
| 五 结果 | 26–32 | 1:15–1:36 | Night bloom. Three fruits ripen, one per cat nearby: 放得下 · 越来越懂 · 不再从零开始. Pull back to the whole glowing tree. | Full orchestral theme, bell chords on each fruit, cymbal swells. |
| 六 森林 | 33–40 | 1:36–2:00 | A fruit falls and sprouts. Crane up: many trees, each with its own rings, roots joined only at shared threads; aurora. Rise into the stars; the lights gather into the three-cat logo. End card: logo mark, "Growing", "Run your own cat café." (no product-name text, so the card stays brand-neutral in this repo). | Broad strings and horns; aurora shimmer; music-box motif returns alone; final chord. |

Cue times and captions live in [`timeline.json`](timeline.json) — the single source for
picture and sound.

## Layout

- `tools/prepare_cats.py` — cuts film sprites from the character canon
  (`feat/roadmap-growing-tree` @ `a44356872`, `docs/design/assets/character-canon`),
  choosing for each pose the high-resolution master that reproduces the canon cell and
  carrying over the cell's scale and foot point. Output → `build/cats/` (gitignored).
- `studio/` — the renderer (`index.html` + `src/`): multiplane camera with depth of
  field, procedural sky/ridges/soil, space-colonisation world tree with pipe-model
  girth and metaball foliage, lit canon cats, SDF person, glass, particles, captions,
  bloom and grading.
- `tools/render.mjs` — serves the studio, drives headless Chrome (GPU via ANGLE/Metal),
  streams raw frames into ffmpeg.
- `audio/` — score + sound design (numpy/scipy), GarageBand orchestral samples for
  strings/horns/flute/brass; synthesised celesta, harp, percussion and all effects.

## Provenance

- Cats: canon masters/cells as above (operator-approved identities); no new generation.
- Logo: `site/assets/logo-transparent.png` from the same branch.
- Orchestral samples: Apple GarageBand sampler library installed on the machine
  (licensed for use in one's own compositions); everything else is synthesised here.
- Fonts: macOS system fonts (Songti SC, Baskerville).

## Build

```bash
tools/build.sh            # sprites -> events -> picture (60 fps) -> sound -> mux
```

- Picture only: `node tools/render.mjs video --from 0 --to 122.5 --fps 60 --out out/picture-60fps.mp4`
  (real time on an M4 Pro at 30 fps; ~6 min at 60 fps). Stills for review:
  `node tools/render.mjs stills 9.6,36.4 [--cam x,y,V] [--dbg nobloom|bloomonly|noparts]`.
- Sound only: `node tools/export-events.mjs && .venv/bin/python audio/mix.py`
  -> `build/audio/growing-mix.wav` (48 kHz, -16 LUFS, <= -1.3 dBTP) plus stems.
- Review sound as a picture: `.venv/bin/python tools/spectro.py build/audio/growing-mix.wav out/spec.png 0 61`.

The studio page also runs interactively: serve the folder and open
`studio/index.html?t=58` (space toggles play).

## Sound

- **Score** (`audio/score.py`): 40 bars, 80 BPM, D major. The four-note "growing"
  motif (A–D–E–F♯) is struck on celesta as the seed lands, answered by flute at dawn,
  stated by solo horn over the lit roots, carried by strings through the fruit, swelled
  by the orchestra over the forest, and left alone on a music box on the mark.
- **Sound design** (`audio/design.py`): every effect sits on the picture's own events,
  exported from the direction code (`tools/export-events.mjs` -> `build/events.json`),
  so paper-plane flights, footsteps, lanterns and fruit land where they are seen.
- **Mix** (`audio/mix.py`): three synthetic convolution spaces (room / hall / big),
  dramatic dynamics automation, two ducked silences (the held breath before the glass
  breaks; the paw that stops) with only a harmonic, a reversed cymbal and a heartbeat
  routed around the duck; BS.1770 loudness to -16 LUFS and a true-peak limiter.

## Status

- [x] canon cat sprites (123, canon-scale, foot anchors)
- [x] tree generator (two-phase colonisation, angle limits, root collar)
- [x] renderer · [x] six acts directed · [x] score · [x] sound design · [x] mix/master
- [ ] operator review (fork hard gate: experience check before anything goes upstream)
