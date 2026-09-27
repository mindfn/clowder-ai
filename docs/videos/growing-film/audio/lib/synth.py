"""Synthesised instruments: mallets (celesta, music box, glockenspiel, bells,
crotales), plucks (harp, pizzicato), choir and pads, and percussion
(timpani, taiko, cymbals, sub drops, heartbeat)."""

from __future__ import annotations

import numpy as np
from scipy import signal

from .dsp import SR, RNG, t_axis, lowpass, highpass, bandpass, resonator, white, pink, midi_hz, mono_to_stereo, expdecay


def _modal(f0: float, modes, dur: float, vel: float = 0.8, click: float = 0.0, click_lp: float = 4000,
           detune_cents: float = 0.0) -> np.ndarray:
    """Sum of exponentially decaying sine modes: (ratio, amp, decay_s)."""
    t = t_axis(dur)
    y = np.zeros_like(t)
    f0 = f0 * 2 ** (detune_cents / 1200)
    for ratio, amp, tau in modes:
        f = f0 * ratio
        if f >= SR * 0.45:
            continue
        ph = RNG.uniform(0, 2 * np.pi)
        # velocity: softer strikes excite fewer upper modes
        a = amp * (vel ** (0.5 + 0.8 * max(0, np.log2(ratio))))
        y += a * np.sin(2 * np.pi * f * t + ph) * np.exp(-t / tau)
    atk = np.clip(t / 0.0015, 0, 1)
    y *= atk
    if click > 0:
        n = min(len(t), int(0.012 * SR))
        c = lowpass(white(n), click_lp, 2) * np.exp(-np.arange(n) / (0.002 * SR))
        y[:n] += c * click * vel
    return y * vel


def celesta(m: float, dur: float = 2.8, vel: float = 0.7) -> np.ndarray:
    f = midi_hz(m)
    k = np.clip((m - 60) / 36, 0, 1)
    modes = [(1.0, 1.0, 1.6 - 0.9 * k), (2.0, 0.06, 0.5), (3.0, 0.1, 0.35), (4.0, 0.22, 0.25), (9.7, 0.04, 0.08)]
    y = _modal(f, modes, dur, vel, click=0.25, click_lp=6000)
    # felt-hammer + resonator box warmth
    y = y + 0.25 * resonator(y, f, 3.0)
    return y * 0.5


def music_box(m: float, dur: float = 3.5, vel: float = 0.7) -> np.ndarray:
    f = midi_hz(m)
    modes = [(1.0, 1.0, 2.4), (1.0025, 0.35, 2.0), (5.4, 0.16, 0.35), (8.93, 0.06, 0.18), (13.3, 0.025, 0.08)]
    y = _modal(f, modes, dur, vel, click=0.35, click_lp=9000)
    return y * 0.45


def glock(m: float, dur: float = 2.5, vel: float = 0.7) -> np.ndarray:
    f = midi_hz(m)
    modes = [(1.0, 1.0, 1.3), (2.76, 0.35, 0.45), (5.40, 0.2, 0.2), (8.93, 0.09, 0.1)]
    return _modal(f, modes, dur, vel, click=0.3, click_lp=10000) * 0.4


def crotale(m: float, dur: float = 5.0, vel: float = 0.7) -> np.ndarray:
    f = midi_hz(m)
    modes = [(1.0, 1.0, 3.2), (1.0017, 0.5, 3.0), (2.76, 0.28, 1.1), (5.40, 0.16, 0.5), (8.93, 0.07, 0.25)]
    return _modal(f, modes, dur, vel, click=0.15, click_lp=12000) * 0.35


def tubular_bell(m: float, dur: float = 7.0, vel: float = 0.7) -> np.ndarray:
    f = midi_hz(m)
    # church-bell style partials (hum, prime, tierce, quint, nominal, ...)
    modes = [(0.5, 0.35, 5.5), (1.0, 1.0, 3.8), (1.19, 0.45, 2.6), (1.5, 0.3, 2.2), (2.0, 0.5, 1.8),
             (2.52, 0.22, 1.1), (3.0, 0.15, 0.8), (4.07, 0.1, 0.5), (5.4, 0.05, 0.3)]
    return _modal(f, modes, dur, vel, click=0.2, click_lp=5000) * 0.3


def glass_ping(f: float, dur: float = 1.2, vel: float = 0.6, bright: float = 1.0) -> np.ndarray:
    modes = [(1.0, 1.0, 0.9 * dur / 1.2), (2.32, 0.4, 0.35), (4.25, 0.25 * bright, 0.15), (6.63, 0.12 * bright, 0.08)]
    return _modal(f, modes, dur, vel, click=0.4 * bright, click_lp=12000) * 0.3


def _ks(f: float, dur: float, decay: float = 3.0, bright: float = 0.6, pick_pos: float = 0.25) -> np.ndarray:
    """Karplus-Strong via an IIR comb (scipy lfilter), tuned exactly by resampling."""
    sr_i = SR * 2
    N = max(4, int(round(sr_i / f - 0.5)))
    f_int = sr_i / (N + 0.5)
    n = int(dur * sr_i)
    burst = white(N) * np.hanning(N)
    # pluck position comb + brightness
    d = max(1, int(N * pick_pos))
    burst = burst - np.concatenate([np.zeros(d), burst[:-d]])
    burst = lowpass(burst, 1500 + 9000 * bright, 1) if len(burst) > 12 else burst
    x = np.zeros(n)
    x[:N] = burst
    g = 10 ** (-3 * (1 / f) / decay)  # per-period loss for the requested T60
    a = np.zeros(N + 2)
    a[0] = 1
    a[N] = -g * 0.5
    a[N + 1] = -g * 0.5
    y = signal.lfilter([1.0], a, x)
    # retune: resample by f_int / f, then down to SR
    ratio = f_int / f
    m = int(len(y) * ratio)
    y = np.interp(np.arange(m) / ratio, np.arange(len(y)), y)
    y = y[::2][: int(dur * SR)]
    return y / (np.max(np.abs(y)) + 1e-9)


def harp(m: float, dur: float = 3.0, vel: float = 0.7) -> np.ndarray:
    f = midi_hz(m)
    decay = float(np.interp(m, [36, 60, 84, 96], [6.0, 3.5, 1.6, 0.9]))
    y = _ks(f, dur, decay, bright=0.35 + 0.4 * vel, pick_pos=0.18)
    body = resonator(y, 220, 1.2) * 0.25 + resonator(y, 520, 1.5) * 0.15
    y = (y + body) * vel * 0.5
    return lowpass(y, 3500 + 6000 * vel, 1)


def pizz(m: float, dur: float = 1.2, vel: float = 0.7) -> np.ndarray:
    f = midi_hz(m)
    y = _ks(f, dur, 0.55, bright=0.3 + 0.3 * vel, pick_pos=0.3)
    y = y + resonator(y, 280, 1.0) * 0.4 + resonator(y, 900, 1.4) * 0.15
    return lowpass(y, 2600 + 2500 * vel, 2) * vel * 0.55


def _saw(f: np.ndarray | float, t: np.ndarray, nh: int | None = None) -> np.ndarray:
    """Band-limited saw by additive partials (f may vary slowly with t)."""
    f = np.broadcast_to(np.asarray(f, dtype=np.float64), t.shape)
    ph = 2 * np.pi * np.cumsum(f) / SR
    fmax = float(np.max(f))
    nh = nh or max(1, int((SR * 0.45) // fmax))
    nh = min(nh, 60)
    y = np.zeros_like(t)
    for k in range(1, nh + 1):
        y += np.sin(k * ph) / k
    return y


def choir(chord: list[float], dur: float, vel: float = 0.6, vowel: str = "ah", attack: float = 1.2,
          release: float = 1.8, voices: int = 3) -> np.ndarray:
    """Formant-filtered detuned saws: a soft 'aah'/'ooh' ensemble. Stereo out."""
    formants = {
        "ah": [(730, 1.0, 80), (1090, 0.5, 90), (2440, 0.25, 120), (3400, 0.08, 150)],
        "oo": [(300, 1.0, 50), (870, 0.35, 80), (2240, 0.08, 120)],
        "eh": [(530, 1.0, 70), (1840, 0.5, 100), (2480, 0.2, 120)],
    }[vowel]
    total = dur + release
    t = t_axis(total)
    out = np.zeros((len(t), 2))
    for m in chord:
        f0 = midi_hz(m)
        for v in range(voices):
            det = RNG.uniform(-9, 9)
            vib = 1 + 0.004 * np.sin(2 * np.pi * RNG.uniform(4.6, 5.6) * t + RNG.uniform(0, 6.28)) * np.clip(t / 1.5, 0, 1)
            drift = 1 + 0.002 * np.sin(2 * np.pi * RNG.uniform(0.1, 0.3) * t)
            src = _saw(f0 * 2 ** (det / 1200) * vib * drift, t)
            src += 0.08 * white(len(t))
            y = np.zeros_like(t)
            for fc, amp, bw in formants:
                y += amp * resonator(src, fc, fc / bw)
            pan = RNG.uniform(-0.7, 0.7)
            out += mono_to_stereo(y, pan).astype(np.float64)
    env = np.clip(t / attack, 0, 1) ** 1.5 * np.where(t > dur, np.clip(1 - (t - dur) / release, 0, 1), 1)
    out *= env[:, None]
    out = highpass(out, 120, 2)
    return (out / (len(chord) * voices) * vel * 0.9).astype(np.float32)


def pad(chord: list[float], dur: float, vel: float = 0.5, cutoff: float = 1800, attack: float = 2.0,
        release: float = 3.0) -> np.ndarray:
    """Warm analogue-ish pad: detuned saws through a slowly breathing lowpass."""
    total = dur + release
    t = t_axis(total)
    out = np.zeros((len(t), 2))
    for m in chord:
        f0 = midi_hz(m)
        for k in range(3):
            det = (k - 1) * 7 + RNG.uniform(-2, 2)
            src = _saw(f0 * 2 ** (det / 1200), t, nh=24)
            out += mono_to_stereo(src, (k - 1) * 0.6).astype(np.float64)
    lfo = cutoff * (0.8 + 0.2 * np.sin(2 * np.pi * 0.07 * t))
    # block-varying lowpass: apply in chunks
    y = np.zeros_like(out)
    blk = int(0.05 * SR)
    zi = None
    sos_list = []
    for i in range(0, len(t), blk):
        fc = float(lfo[i])
        sos = signal.butter(2, fc / (SR / 2), output="sos")
        if zi is None:
            zi = np.zeros((sos.shape[0], 2, 2))
        seg, zi = signal.sosfilt(sos, out[i : i + blk], axis=0, zi=zi)
        y[i : i + blk] = seg
    env = np.clip(t / attack, 0, 1) ** 2 * np.where(t > dur, np.clip(1 - (t - dur) / release, 0, 1), 1)
    y *= env[:, None]
    return (y / (len(chord) * 3) * vel).astype(np.float32)


# ---------------------------------------------------------------- percussion
def timpani(m: float, dur: float = 3.0, vel: float = 0.7) -> np.ndarray:
    f = midi_hz(m)
    t = t_axis(dur)
    glide = 1 + 0.03 * np.exp(-t / 0.05)
    ph = 2 * np.pi * np.cumsum(f * glide) / SR
    y = (np.sin(ph) * np.exp(-t / 1.6) + 0.5 * np.sin(1.5 * ph) * np.exp(-t / 0.9)
         + 0.3 * np.sin(1.98 * ph) * np.exp(-t / 0.6) + 0.18 * np.sin(2.44 * ph) * np.exp(-t / 0.4))
    n = int(0.03 * SR)
    y[:n] += lowpass(white(n), 1200, 2) * np.exp(-np.arange(n) / (0.006 * SR)) * 0.6
    return y * vel * 0.5


def timpani_roll(m: float, dur: float, v0: float = 0.2, v1: float = 0.9, rate: float = 16.0) -> np.ndarray:
    total = dur + 2.5
    out = np.zeros(int(total * SR))
    t = 0.0
    while t < dur:
        v = v0 + (v1 - v0) * (t / dur) ** 1.5
        hit = timpani(m, 2.5, v * RNG.uniform(0.85, 1.0))
        i = int(t * SR)
        out[i : i + len(hit)] += hit[: len(out) - i]
        t += 1 / rate * RNG.uniform(0.85, 1.15)
    return out * 0.45


def taiko(dur: float = 2.0, vel: float = 0.9, f: float = 52.0) -> np.ndarray:
    t = t_axis(dur)
    pitch = f * (1 + 0.7 * np.exp(-t / 0.03))
    ph = 2 * np.pi * np.cumsum(pitch) / SR
    body = np.sin(ph) * np.exp(-t / 0.55)
    skin = lowpass(white(len(t)), 900, 2) * np.exp(-t / 0.08) * 0.5
    y = body + skin
    return np.tanh(y * 1.8) * vel * 0.8


def sub_drop(dur: float = 2.5, f0: float = 70, f1: float = 30, vel: float = 0.9) -> np.ndarray:
    t = t_axis(dur)
    f = f1 + (f0 - f1) * np.exp(-t / 0.35)
    y = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 1.0) * np.clip(t / 0.005, 0, 1)
    return np.tanh(y * 1.5) * vel * 0.9


def heartbeat(vel: float = 0.8) -> np.ndarray:
    dur = 0.8
    t = t_axis(dur)

    def thump(t0, f, a):
        tt = np.maximum(t - t0, 0)
        on = (t >= t0).astype(float)
        return on * a * np.sin(2 * np.pi * f * tt * (1 + 0.5 * np.exp(-tt / 0.02))) * np.exp(-tt / 0.07)

    y = thump(0.0, 52, 1.0) + thump(0.28, 60, 0.7)
    y = lowpass(y, 200, 2)
    return np.tanh(y * 2.0) * vel * 0.8


def cymbal(dur: float = 4.0, vel: float = 0.7, swell: bool = False, bright: float = 1.0) -> np.ndarray:
    t = t_axis(dur)
    n = white(len(t))
    y = highpass(n, 2500, 2) * 0.4
    for fc in [3150, 4470, 5810, 7230, 8990, 10660, 12400]:
        y += resonator(n, fc * RNG.uniform(0.97, 1.03), 18) * 0.35
    y = highpass(y, 1800 - 600 * (1 - bright), 2)
    if swell:
        env = (t / dur) ** 2.2
        env *= np.clip((dur - t) / 0.03, 0, 1)
    else:
        env = np.exp(-t / (dur / 3.5)) * np.clip(t / 0.002, 0, 1)
    return y * env * vel * 0.25


def riser(dur: float, f0: float = 300, f1: float = 9000, vel: float = 0.6, tonal: float = 0.3) -> np.ndarray:
    from .dsp import sweep_filter

    t = t_axis(dur)
    c = f0 * (f1 / f0) ** ((t / dur) ** 1.6)
    y = sweep_filter(white(len(t)), c, width_oct=1.2)
    if tonal > 0:
        f = 110 * (4 ** ((t / dur) ** 1.4))
        ph = 2 * np.pi * np.cumsum(f) / SR
        y += tonal * (np.sin(ph) + 0.5 * np.sin(1.5 * ph) + 0.3 * np.sin(2 * ph)) * 0.2
    env = (t / dur) ** 2.0
    return y * env * vel


def reverse(x: np.ndarray) -> np.ndarray:
    return x[::-1].copy()
