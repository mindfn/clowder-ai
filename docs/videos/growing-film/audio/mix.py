"""Render the score and the sound design, mix through reverb sends, master.

    python audio/mix.py            -> build/audio/growing-mix.wav (+ stems)
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import numpy as np
from scipy.io import wavfile

sys.path.insert(0, str(Path(__file__).resolve().parent))

from lib.dsp import SR, make_ir, convolve, compress, limit, highpass, shelf, peaking, db, lufs, true_peak_db, curve  # noqa: E402
from lib.sampler import orchestra  # noqa: E402
from score import Score  # noqa: E402
from design import Design  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "build" / "audio"

# group: (gain dB, reverb, send)
MIX = {
    "strings": (0.0, "hall", 0.30),
    "brass": (-1.0, "hall", 0.32),
    "winds": (-1.0, "hall", 0.30),
    "keys": (-2.0, "big", 0.36),
    "bells": (-3.0, "big", 0.45),
    "choir": (-2.0, "big", 0.45),
    "perc": (-1.0, "hall", 0.20),
    "musicbox": (0.0, "big", 0.42),
    "sub": (-2.0, None, 0.0),
    "amb": (-3.0, "room", 0.10),
    "fx": (-2.0, "room", 0.16),
    "fx_hall": (-3.0, "big", 0.42),
    "foley": (-2.0, "room", 0.22),
    "exempt_m": (0.0, "big", 0.35),
    "exempt_fx": (-1.0, "room", 0.2),
}
EXEMPT = {"exempt_m", "exempt_fx"}
# silences: the held breath before the glass breaks, and the paw that stops
DUCK = [(0, 0), (35.24, 0), (35.33, -30), (35.96, -30), (36.0, 0), (68.97, 0), (69.08, -22), (70.35, -22), (70.95, 0), (122.5, 0)]
MUSIC = {"strings", "brass", "winds", "keys", "bells", "choir", "perc", "musicbox", "sub"}

# dramatic dynamics (dB) over film time, for the music bus and the effects bus
MUSIC_DYN = [(0, -5), (8.5, -5), (9.5, -2.5), (17, -1.5), (18, 0), (33, 0.5), (35.3, 1), (36.0, 2), (39, -1), (44, 0),
             (53, -1.5), (54, -4), (64, -3.5), (66, -2), (68.9, -2), (69.05, -14), (70.3, -13), (70.9, -3), (74, 0),
             (75, 2), (93, 2.5), (96, 3), (97, 0), (99, 2.5), (104, 1.5), (108, -1), (111, -1.5), (122.5, -3)]
FX_DYN = [(0, 0), (66, 0), (68.9, 0), (69.05, -9), (70.4, -9), (70.9, 0), (122.5, 0)]
AMB_DYN = [(0, 0), (68.9, 0), (69.05, -12), (70.4, -12), (71.2, 0), (122.5, 0)]


def write_wav(path: Path, x: np.ndarray):
    path.parent.mkdir(parents=True, exist_ok=True)
    wavfile.write(str(path), SR, np.clip(x, -1, 1).astype(np.float32))


def main():
    t0 = time.time()
    ev = json.loads((ROOT / "build" / "events.json").read_text())
    timeline = json.loads((ROOT / "timeline.json").read_text())
    duration = timeline["bars"] * 3.0 + timeline["tail"]
    print(f"duration {duration:.1f}s")

    orc = orchestra()
    score = Score(orc, duration)
    tracks = dict(score.write())
    print(f"score rendered {time.time() - t0:.1f}s")
    design = Design(ev, duration)
    tracks.update(design.write())
    print(f"design rendered {time.time() - t0:.1f}s")

    irs = {
        "room": make_ir(1.1, 0.5, 1.6, predelay=0.012, seed=3, width=0.8, damp_hz=6000),
        "hall": make_ir(2.9, 1.3, 4.0, predelay=0.028, seed=5, width=1.0, damp_hz=7500),
        "big": make_ir(4.8, 2.0, 6.5, predelay=0.04, seed=7, width=1.2, damp_hz=8000),
    }
    sends = {k: np.zeros_like(next(iter(tracks.values())).buf) for k in irs}
    music = np.zeros_like(sends["room"])
    fx = np.zeros_like(sends["room"])
    stems = {}
    n_all = len(next(iter(tracks.values())).buf)
    dyn_music = (10 ** (curve(n_all, MUSIC_DYN) / 20)).astype(np.float32)[:, None]
    dyn_fx = (10 ** (curve(n_all, FX_DYN) / 20)).astype(np.float32)[:, None]
    dyn_amb = (10 ** (curve(n_all, AMB_DYN) / 20)).astype(np.float32)[:, None]
    ex = np.zeros_like(music)
    ex_sends = {k: np.zeros_like(music) for k in irs}
    for name, tr in tracks.items():
        g, rv, send = MIX[name]
        x = tr.buf * db(g)
        if name in EXEMPT:
            ex += x
            ex_sends[rv] += x * send
            stems[name] = x
            continue
        x = x * (dyn_music if name in MUSIC else dyn_amb if name == "amb" else dyn_fx)
        stems[name] = x
        if rv:
            sends[rv] += x * send
        (music if name in MUSIC else fx)[:] += x
    wet = {k: convolve(v, irs[k]) for k, v in sends.items()}
    ex_wet = sum(convolve(v, irs[k]) for k, v in ex_sends.items() if np.any(v))
    print(f"reverbs {time.time() - t0:.1f}s")
    mix = music + fx + wet["room"] * 0.9 + wet["hall"] * 1.0 + wet["big"] * 1.0
    duck = (10 ** (curve(n_all, DUCK) / 20)).astype(np.float32)[:, None]
    mix = mix * duck + ex + ex_wet
    # gentle glue on the whole mix, then tone and limiting
    mix = highpass(mix, 24, 2).astype(np.float32)
    mix = shelf(mix, 110, 1.0, high=False).astype(np.float32)
    mix = shelf(mix, 9000, 1.5, high=True).astype(np.float32)
    mix = peaking(mix, 320, -1.2, 0.8).astype(np.float32)
    mix = compress(mix, thresh_db=-12, ratio=1.4, attack=0.04, release=0.35, knee_db=10)
    # loudness: -16 LUFS integrated, true peak <= -1 dBTP
    target = -16.0
    for _ in range(3):
        L = lufs(mix)
        mix = mix * db(target - L)
        mix = limit(mix, ceiling_db=-1.9, lookahead=0.004, release=0.15)
    print(f"loudness {lufs(mix):.1f} LUFS, true peak {true_peak_db(mix):.1f} dBTP")
    write_wav(OUT / "growing-mix.wav", mix)
    for name, x in stems.items():
        write_wav(OUT / "stems" / f"{name}.wav", x / (np.max(np.abs(x)) + 1e-9) * 0.9)
    # quick level report per act
    acts = [(0, 18), (18, 36), (36, 54), (54, 75), (75, 96), (96, 122.5)]
    for a, b in acts:
        seg = mix[int(a * SR) : int(b * SR)]
        rms = 20 * np.log10(np.sqrt(np.mean(seg ** 2)) + 1e-9)
        pk = 20 * np.log10(np.max(np.abs(seg)) + 1e-9)
        m = music[int(a * SR) : int(b * SR)]
        f = fx[int(a * SR) : int(b * SR)]
        rm = 20 * np.log10(np.sqrt(np.mean(m ** 2)) + 1e-9)
        rf = 20 * np.log10(np.sqrt(np.mean(f ** 2)) + 1e-9)
        print(f"  {a:5.1f}-{b:5.1f}s  mix rms {rms:6.1f} dB  peak {pk:6.1f}  | music {rm:6.1f}  fx {rf:6.1f}")
    print(f"done {time.time() - t0:.1f}s -> {OUT / 'growing-mix.wav'}")


if __name__ == "__main__":
    main()
