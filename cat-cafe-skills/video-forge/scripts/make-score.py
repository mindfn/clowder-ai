#!/usr/bin/env python3
"""Grid-locked score and sound effects, synthesized from scratch (no samples, no licences).

The music sits exactly on the picture grid: at 120 BPM and 30 fps a beat is 15 frames
and a bar 60, so every cut and pop can land on a beat. Sections are chosen per bar;
silences (the record stopping) are given in frames, the same numbers as the timeline.

Usage:
  python3 make-score.py <out_dir> --bars 23 \
      --sections "0-1:intro,2-9:groove,10-14:melody,15-16:box,17-18:groove,19-21:melody,22:resolve" \
      [--bpm 120] [--fps 30] [--prog C,G,Am,F] [--mute 248-360]

Section modes: intro (light plucks building), groove (ukulele strum, bass, kick, shaker),
melody (groove plus a glockenspiel line), box (music box only, for sleepy or tender
moments), resolve (one ringing C chord), rest (silence). Bars not listed are rest.
Writes <out_dir>/score.wav and <out_dir>/sfx/*.wav (pop, tape, whoosh, thud, ding,
scratch, boing, sparkle, marker, heart, chime, blip, shock).

Made for Ragdoll喵变脸记 (2026-10-04); the film's own score used exactly the example above.
Needs numpy. You cannot hear the result: check structure with per-bar loudness, and let
the human judge whether it sounds good.
"""

import argparse
import sys
import wave
from pathlib import Path

import numpy as np

SR = 44100
BPM = 120
BEAT = 60 / BPM
BAR = 4 * BEAT

rng = np.random.default_rng(20261004)


def midi(n):
    return 440.0 * 2 ** ((n - 69) / 12)


def pluck(freq, dur, decay=0.996, bright=0.5):
    """Karplus-Strong string: a soft ukulele-ish pluck."""
    n = int(SR * dur)
    period = max(2, int(SR / freq))
    buf = rng.uniform(-1, 1, period) * bright + rng.uniform(-1, 1, period) * (1 - bright) * 0.3
    out = np.zeros(n)
    for i in range(n):
        out[i] = buf[i % period]
        nxt = (i + 1) % period
        buf[i % period] = decay * 0.5 * (buf[i % period] + buf[nxt])
    env = np.minimum(1, np.arange(n) / (0.002 * SR))
    return out * env


def bell(freq, dur, decay=4.0):
    t = np.arange(int(SR * dur)) / SR
    tone = np.sin(2 * np.pi * freq * t) + 0.35 * np.sin(2 * np.pi * freq * 2.76 * t) + 0.12 * np.sin(2 * np.pi * freq * 5.4 * t)
    return tone * np.exp(-decay * t) * np.minimum(1, t / 0.003)


def kick(dur=0.25):
    t = np.arange(int(SR * dur)) / SR
    f = 55 + 70 * np.exp(-t * 30)
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 14)


def shaker(dur=0.06):
    n = int(SR * dur)
    x = rng.uniform(-1, 1, n)
    x = np.diff(np.concatenate([[0], x]))  # crude high-pass
    return x * np.exp(-np.arange(n) / (0.012 * SR))


def place(track, clip, at_s, gain=1.0):
    i = int(at_s * SR)
    if i >= len(track):
        return
    j = min(len(track), i + len(clip))
    track[i:j] += clip[: j - i] * gain


CHORDS = {
    'C': [60, 64, 67, 72],
    'G': [55, 59, 62, 67],
    'Am': [57, 60, 64, 69],
    'F': [53, 57, 60, 65],
}
PROG = ['C', 'G', 'Am', 'F']
STRUM = [(0, 1.0, 'd'), (2, 0.6, 'd'), (3, 0.5, 'u'), (5, 0.55, 'u'), (6, 0.7, 'd'), (7, 0.45, 'u')]
MELODY_A = [(0, 76), (1.5, 79), (2, 81), (3, 79), (4, 76), (5, 74), (6, 72), (7.5, 74)]  # in beats over 2 bars


def strum(track, chord, at_s, vel, direction):
    notes = CHORDS[chord] if direction == 'd' else list(reversed(CHORDS[chord]))
    for k, n in enumerate(notes):
        place(track, pluck(midi(n), 1.2, decay=0.995, bright=0.6), at_s + k * 0.012, 0.22 * vel)


def bar_groove(track, bar, chord, level, with_kick=True, with_melody=False):
    start = bar * BAR
    for eighth, vel, d in STRUM:
        strum(track, chord, start + eighth * BEAT / 2, vel * level, d)
    root = CHORDS[chord][0] - 24
    for beat in (0, 2):
        place(track, pluck(midi(root), 0.9, decay=0.993, bright=0.2), start + beat * BEAT, 0.5 * level)
        if with_kick:
            place(track, kick(), start + beat * BEAT, 0.55 * level)
    for e in range(8):
        place(track, shaker(), start + e * BEAT / 2, (0.05 if e % 2 == 0 else 0.09) * level)
    if with_melody:
        offset = 0 if bar % 2 == 0 else 4
        for b, n in MELODY_A:
            if offset <= b < offset + 4:
                place(track, bell(midi(n), 0.9), start + (b - offset) * BEAT, 0.16 * level)


def music_box(track, bar, chord):
    start = bar * BAR
    notes = CHORDS[chord] + [CHORDS[chord][1] + 12]
    for k, n in enumerate(notes):
        place(track, bell(midi(n + 12), 1.6, decay=2.2), start + k * BEAT * 0.75, 0.13)



MODES = {'intro', 'groove', 'melody', 'box', 'resolve', 'rest'}


def parse_sections(spec, bars):
    plan = ['rest'] * bars
    for part in filter(None, (p.strip() for p in spec.split(','))):
        try:
            span, mode = part.split(':')
            lo, _, hi = span.partition('-')
            lo, hi = int(lo), int(hi or lo)
        except ValueError:
            sys.exit(f'make-score: bad section "{part}" (want e.g. 2-9:groove)')
        if mode not in MODES:
            sys.exit(f'make-score: unknown mode "{mode}" (one of {sorted(MODES)})')
        if lo < 0 or hi >= bars or lo > hi:
            sys.exit(f'make-score: section "{part}" is outside 0..{bars - 1}')
        for b in range(lo, hi + 1):
            plan[b] = mode
    return plan


def make_score(plan, prog, mutes, fps):
    total = len(plan) * BAR
    track = np.zeros(int(SR * (total + 2)))
    intro_n = 0
    for bar, mode in enumerate(plan):
        chord = prog[bar % len(prog)]
        t0 = bar * BAR
        if mode == 'intro':
            for eighth, vel, d in STRUM[:3]:
                strum(track, chord, t0 + eighth * BEAT / 2, vel * min(1.0, 0.5 + 0.25 * intro_n), d)
            intro_n += 1
        elif mode == 'box':
            music_box(track, bar, chord)
        elif mode == 'resolve':
            strum(track, 'C', t0, 1.0, 'd')
            place(track, bell(midi(84), 2.5, decay=1.4), t0, 0.2)
            place(track, pluck(midi(36), 2.0, decay=0.997, bright=0.2), t0, 0.5)
        elif mode in ('groove', 'melody'):
            bar_groove(track, bar, chord, level=0.85, with_melody=mode == 'melody')
    fade = int(0.02 * SR)
    for a_f, b_f in mutes:
        a, b = int(a_f / fps * SR), int(b_f / fps * SR)
        track[a : a + fade] *= np.linspace(1, 0, len(track[a : a + fade]))
        track[a + fade : b] = 0
    end = int(total * SR)
    tail = int(0.4 * SR)
    track[end - tail : end] *= np.linspace(1, 0, tail)
    track = track[:end]
    return track / (np.max(np.abs(track)) + 1e-9) * 0.85


def env(n, attack=0.002, release=None):
    a = np.minimum(1, np.arange(n) / (attack * SR))
    r = np.ones(n) if release is None else np.exp(-np.arange(n) / (release * SR))
    return a * r


def sweep(f0, f1, dur, shape='sin'):
    t = np.arange(int(SR * dur)) / SR
    f = f0 * (f1 / f0) ** (t / dur)
    phase = 2 * np.pi * np.cumsum(f) / SR
    return np.sin(phase)


def noise(dur):
    return rng.uniform(-1, 1, int(SR * dur))


def bandish(x, k=6):
    # cheap smoothing low-pass by moving average
    return np.convolve(x, np.ones(k) / k, mode='same')


def make_sfx():
    s = {}
    s['pop'] = sweep(500, 1400, 0.07) * env(int(0.07 * SR), release=0.03)
    s['tape'] = bandish(noise(0.09), 3) * env(int(0.09 * SR), release=0.025) * 0.7
    w = noise(0.35)
    s['whoosh'] = bandish(w, 18) * np.sin(np.linspace(0, np.pi, len(w))) ** 2 * 1.6
    t = np.arange(int(0.35 * SR)) / SR
    s['thud'] = (np.sin(2 * np.pi * np.cumsum(70 + 60 * np.exp(-t * 25)) / SR) * np.exp(-t * 11)
                 + bandish(noise(0.35), 4) * np.exp(-t * 40) * 0.4)
    s['ding'] = bell(1568, 0.8, decay=4.5) + 0.5 * bell(2093, 0.8, decay=5)
    sc = sweep(900, 120, 0.45) * 0.5 + bandish(noise(0.45), 2) * 0.5
    s['scratch'] = sc * np.linspace(1, 0.2, len(sc))
    t = np.arange(int(0.4 * SR)) / SR
    f = 320 * (1 - 0.45 * t / 0.4) * (1 + 0.06 * np.sin(2 * np.pi * 18 * t))
    s['boing'] = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 6)
    sp = np.zeros(int(0.6 * SR))
    for k, n in enumerate([88, 91, 96]):
        b = bell(midi(n), 0.4, decay=9)
        i = int(k * 0.07 * SR)
        sp[i : i + len(b)] += b[: len(sp) - i]
    s['sparkle'] = sp * 0.6
    m = noise(0.5)
    mod = (np.sin(2 * np.pi * 11 * np.arange(len(m)) / SR) > 0).astype(float) * 0.7 + 0.3
    s['marker'] = bandish(m, 2) * mod * env(len(m), release=None) * 0.35
    s['heart'] = np.concatenate([sweep(700, 1000, 0.05), sweep(1000, 1400, 0.06)]) * 0.8
    ch = np.zeros(int(1.6 * SR))
    for k, n in enumerate([72, 76, 79, 84]):
        b = bell(midi(n), 1.4, decay=3)
        i = int(k * 0.09 * SR)
        ch[i : i + len(b)] += b[: len(ch) - i]
    s['chime'] = ch * 0.5
    s['blip'] = sweep(1200, 1300, 0.04) * env(int(0.04 * SR), release=0.015) * 0.5
    t = np.arange(int(0.5 * SR)) / SR
    s['shock'] = (sweep(300, 1800, 0.18) * env(int(0.18 * SR), release=0.08)).tolist() + [0.0] * (len(t) - int(0.18 * SR))
    s['shock'] = np.array(s['shock'])
    return {k: v / (np.max(np.abs(v)) + 1e-9) * 0.8 for k, v in s.items()}


def write_wav(path, x):
    x = np.clip(x, -1, 1)
    pcm = (x * 32767).astype('<i2')
    stereo = np.repeat(pcm[:, None], 2, axis=1).tobytes()
    with wave.open(str(path), 'wb') as f:
        f.setnchannels(2)
        f.setsampwidth(2)
        f.setframerate(SR)
        f.writeframes(stereo)


def main():
    global BPM, BEAT, BAR
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('out_dir')
    ap.add_argument('--bars', type=int, required=True)
    ap.add_argument('--sections', required=True)
    ap.add_argument('--bpm', type=float, default=120)
    ap.add_argument('--fps', type=int, default=30)
    ap.add_argument('--prog', default='C,G,Am,F', help='chords from: ' + ','.join(CHORDS))
    ap.add_argument('--mute', action='append', default=[], help='silence a frame range, e.g. 248-360 (repeatable)')
    args = ap.parse_args()

    BPM, BEAT, BAR = args.bpm, 60 / args.bpm, 4 * 60 / args.bpm
    prog = [c.strip() for c in args.prog.split(',') if c.strip()]
    bad = [c for c in prog if c not in CHORDS]
    if bad:
        sys.exit(f'make-score: unknown chord(s) {bad}; known: {list(CHORDS)}')
    mutes = []
    for m in args.mute:
        try:
            a, b = (int(x) for x in m.split('-'))
        except ValueError:
            sys.exit(f'make-score: bad --mute "{m}" (want start-end in frames)')
        if a >= b:
            sys.exit(f'make-score: --mute "{m}" ends before it starts')
        mutes.append((a, b))
    plan = parse_sections(args.sections, args.bars)

    out = Path(args.out_dir)
    (out / 'sfx').mkdir(parents=True, exist_ok=True)
    write_wav(out / 'score.wav', make_score(plan, prog, mutes, args.fps))
    sfx = make_sfx()
    for name, clip in sfx.items():
        write_wav(out / 'sfx' / f'{name}.wav', clip)
    frames_per_beat = args.fps * 60 / BPM
    print(f'wrote {out / "score.wav"} ({args.bars} bars, {args.bars * BAR:.1f} s; '
          f'{frames_per_beat:g} frames per beat) and {len(sfx)} sfx')


if __name__ == '__main__':
    main()
