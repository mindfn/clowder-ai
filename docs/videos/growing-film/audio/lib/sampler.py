"""Sampled orchestra from the GarageBand sampler library installed on this Mac.

Each instrument maps MIDI roots to sample files. A note picks the nearest
root (optionally preferring fast attacks), pitch-shifts by reading a 4x
oversampled copy, extends long notes by crossfade looping the sustain, and
shapes the result with its own attack/release.
"""

from __future__ import annotations

import os
import re
import warnings
from functools import lru_cache

import numpy as np
from scipy import signal
from scipy.io import wavfile

from .dsp import SR, NOTE_INDEX, RNG, lowpass

BASE = "/Library/Application Support/GarageBand/Instrument Library/Sampler/Sampler Files/"
OVS = 4


def root_of(name: str) -> int | None:
    m = re.findall(r"([A-G]#?)(-?\d)", name)
    if not m:
        return None
    n, o = m[-1]
    return 12 * (int(o) + 1) + NOTE_INDEX[n]


@lru_cache(maxsize=None)
def load(path: str):
    """Returns (oversampled stereo float32 at 44100*OVS, native rate, attack90 s)."""
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        sr, x = wavfile.read(path)
    x = x.astype(np.float32)
    if x.dtype.kind in "iu" or np.max(np.abs(x)) > 2:
        x = x / 32768.0
    if x.ndim == 1:
        x = np.stack([x, x], 1)
    x = x[:, :2]
    xo = signal.resample_poly(x, OVS, 1, axis=0).astype(np.float32)
    mono = np.abs(x).mean(1)
    hop = int(sr * 0.02)
    rms = np.sqrt(np.convolve(mono ** 2, np.ones(hop) / hop, mode="same"))
    pk = rms.max() + 1e-9
    a90 = np.argmax(rms > 0.9 * pk) / sr
    a30 = np.argmax(rms > 0.3 * pk) / sr
    return xo, sr, float(a90), float(a30), float(pk)


class Instrument:
    def __init__(self, name: str, folders: list[str], gain: float = 1.0, prefer_fast: bool = False,
                 max_attack: float = 99.0, lp: float | None = None):
        self.name = name
        self.gain = gain
        self.lp = lp
        self.roots: dict[int, list[str]] = {}
        for folder in folders:
            d = os.path.join(BASE, folder)
            for f in sorted(os.listdir(d)):
                if not f.lower().endswith(".wav"):
                    continue
                r = root_of(f)
                if r is None:
                    continue
                self.roots.setdefault(r, []).append(os.path.join(d, f))
        if prefer_fast or max_attack < 99:
            for r, paths in list(self.roots.items()):
                scored = sorted(paths, key=lambda p: load(p)[2])
                ok = [p for p in scored if load(p)[2] <= max_attack]
                self.roots[r] = ok or scored[:1]
        self.keys = np.array(sorted(self.roots))

    def pick(self, midi: float) -> tuple[str, int]:
        i = int(np.argmin(np.abs(self.keys - midi)))
        r = int(self.keys[i])
        paths = self.roots[r]
        return paths[int(RNG.integers(len(paths)))], r

    def note(self, midi: float, dur: float, vel: float = 0.8, attack: float = 0.02, release: float = 0.5,
             offset: float = 0.0, detune: float = 0.0, bright: float = 1.0) -> np.ndarray:
        path, root = self.pick(midi)
        xo, sr, a90, a30, pk = load(path)
        ratio = 2 ** ((midi - root + detune / 100) / 12)
        step = ratio * sr / SR * OVS  # oversampled input samples per output sample
        total = dur + release
        n_out = int(total * SR)
        start = offset * sr * OVS
        pos = start + np.arange(n_out) * step
        avail = len(xo) - 2
        if pos[-1] >= avail:
            xo = extend(xo, sr, int(pos[-1]) + 2)
            avail = len(xo) - 2
        idx = pos.astype(np.int64)
        frac = (pos - idx).astype(np.float32)[:, None]
        y = xo[idx] * (1 - frac) + xo[np.minimum(idx + 1, avail)] * frac
        # envelope: optional soft attack on top of the sample's own, and release
        t = np.arange(n_out) / SR
        env = np.clip(t / max(attack, 1e-3), 0, 1) if attack > 0 else np.ones(n_out)
        rel = np.clip(1 - (t - dur) / max(release, 1e-3), 0, 1)
        env = env * np.where(t > dur, rel ** 1.5, 1.0)
        y = y * env[:, None].astype(np.float32)
        # velocity: level and a touch of brightness
        g = self.gain * (0.25 + 0.75 * vel) / (pk * 4)
        y = y * g
        cutoff = (self.lp or 16000) * (0.45 + 0.55 * vel) * bright
        if cutoff < 15000:
            y = lowpass(y, cutoff, 2).astype(np.float32)
        return y


@lru_cache(maxsize=None)
def _ext_key(path_id: int, n: int):  # pragma: no cover - cache helper
    return None


def extend(xo: np.ndarray, sr: int, need: int) -> np.ndarray:
    """Crossfade-loop the sustain until the buffer is `need` samples long."""
    a = int(1.2 * sr * OVS)
    b = len(xo) - int(0.6 * sr * OVS)
    if b - a < int(1.0 * sr * OVS):
        a = len(xo) // 3
        b = len(xo) - len(xo) // 8
    xf = int(0.35 * sr * OVS)
    out = xo[:b].copy()
    seg = xo[a:b]
    w = np.linspace(0, 1, xf, dtype=np.float32)[:, None]
    w_in = np.sin(w * np.pi / 2)
    w_out = np.cos(w * np.pi / 2)
    while len(out) < need:
        # alternate forward segments with crossfades
        tail = out[-xf:] * w_out + seg[:xf] * w_in
        out = np.concatenate([out[:-xf], tail, seg[xf:]])
    return out


# --------------------------------------------------------------- the orchestra
def orchestra():
    return {
        "strings": Instrument("strings", ["String Ensemble"], gain=0.9, lp=14000),
        "strings_fast": Instrument("strings_fast", ["String Ensemble"], gain=0.9, max_attack=1.4, lp=14000),
        "horns": Instrument("horns", ["French Horns/French Horns_nA_sus_mf"], gain=0.8, max_attack=1.2, lp=9000),
        "horns_f": Instrument("horns_f", ["French Horns/French Horns_nA_sus_f"], gain=0.8, max_attack=1.2, lp=11000),
        "horn_solo": Instrument("horn_solo", ["Horn Solo/French Horn-L_oV_nA_sus_mf"], gain=0.85, max_attack=1.2, lp=9000),
        "horns_stac": Instrument("horns_stac", ["French Horns/French Horns_stac_mf1"], gain=0.8, lp=9000),
        "flute": Instrument("flute", ["Flute Solo/Flute_LV_na_sus_mf"], gain=0.75, max_attack=2.2, lp=12000),
        "clarinet": Instrument("clarinet", ["Clarinet Solo/Clarinet-L_pA_sus_mf"], gain=0.7, max_attack=2.2, lp=9000),
        "trumpets": Instrument("trumpets", ["Trumpets/Trumpets_nA_sus_f"], gain=0.7, max_attack=0.8, lp=12000),
        "trombones": Instrument("trombones", ["Trombones/Trombones_nA_sus_ff"], gain=0.8, max_attack=1.0, lp=9000),
        "tuba": Instrument("tuba", ["Tuba Solo/Tuba-L_nA_sus_mf"], gain=0.8, lp=5000),
    }
