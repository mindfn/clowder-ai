"""Sound effects, all synthesised: ambiences, glass, paper, footsteps, light,
roots, whooshes and sparkles. Each returns mono or stereo float arrays."""

from __future__ import annotations

import numpy as np

from .dsp import SR, RNG, t_axis, lowpass, highpass, bandpass, resonator, white, pink, brown, sweep_filter, mono_to_stereo, samples, fade, tail_fade
from . import synth


# ---------------------------------------------------------------- ambiences
def wind(dur: float, strength: float = 0.5, gusty: float = 0.5, seed: int = 0) -> np.ndarray:
    rng = np.random.default_rng(seed)
    n = samples(dur)
    t = np.arange(n) / SR
    out = np.zeros((n, 2))
    for ch in range(2):
        x = pink(n)
        slow = np.interp(t, np.linspace(0, dur, max(4, int(dur * 0.6))), rng.uniform(0.3, 1.0, max(4, int(dur * 0.6))))
        c = 380 + 900 * slow * (0.6 + 0.4 * gusty)
        y = sweep_filter(x, c, width_oct=1.6, nfft=4096)
        y += 0.35 * lowpass(brown(n), 180, 2)
        amp = 0.55 + 0.45 * slow * gusty
        out[:, ch] = y * amp
    return fade(out * strength * 0.12, min(1.5, dur / 4), min(2.0, dur / 4)).astype(np.float32)


def crickets(dur: float, density: float = 1.0, seed: int = 1) -> np.ndarray:
    rng = np.random.default_rng(seed)
    n = samples(dur)
    out = np.zeros((n, 2))
    for c in range(int(5 * density)):
        f = rng.uniform(3900, 5200)
        pulse_rate = rng.uniform(26, 38)
        period = rng.uniform(0.55, 1.2)
        pan = rng.uniform(-0.9, 0.9)
        amp = rng.uniform(0.3, 1.0)
        t0 = rng.uniform(0, period)
        chirp_len = rng.uniform(0.12, 0.2)
        L = samples(chirp_len)
        tt = np.arange(L) / SR
        chirp = np.sin(2 * np.pi * f * tt) * (0.5 + 0.5 * np.sign(np.sin(2 * np.pi * pulse_rate * tt))) * np.hanning(L)
        chirp = bandpass(chirp, f * 0.8, f * 1.2, 2)
        st = mono_to_stereo(chirp * amp, pan)
        t = t0
        while t < dur:
            i = samples(t)
            j = min(n, i + L)
            out[i:j] += st[: j - i]
            t += period * rng.uniform(0.9, 1.1)
    return (out * 0.025).astype(np.float32)


def birds(dur: float, count: int = 6, seed: int = 2) -> np.ndarray:
    rng = np.random.default_rng(seed)
    n = samples(dur)
    out = np.zeros((n, 2))
    for _ in range(count):
        t = rng.uniform(0, dur - 0.8)
        pan = rng.uniform(-0.8, 0.8)
        notes = rng.integers(2, 6)
        base = rng.uniform(2600, 4200)
        for k in range(notes):
            L = samples(rng.uniform(0.05, 0.13))
            tt = np.arange(L) / SR
            f = base * (1 + rng.uniform(-0.25, 0.35) * np.sin(np.pi * tt / tt[-1])) * (1 + 0.1 * np.sin(2 * np.pi * rng.uniform(30, 60) * tt))
            ph = 2 * np.pi * np.cumsum(f) / SR
            c = np.sin(ph) * np.sin(np.pi * np.arange(L) / L) ** 1.5
            i = samples(t)
            j = min(n, i + L)
            out[i:j] += mono_to_stereo(c, pan)[: j - i] * rng.uniform(0.4, 1.0)
            t += rng.uniform(0.08, 0.2)
    return (out * 0.03).astype(np.float32)


# ---------------------------------------------------------------- motion
def whoosh(dur: float, f0: float = 400, f1: float = 2400, vel: float = 0.6, pan0: float = 0.0, pan1: float = 0.0,
           peak: float = 0.6, width: float = 1.4) -> np.ndarray:
    n = samples(dur)
    t = np.arange(n) / SR
    u = t / dur
    c = f0 * (f1 / f0) ** u
    y = sweep_filter(pink(n) + 0.3 * white(n), c, width_oct=width)
    env = np.where(u < peak, (u / peak) ** 2, ((1 - u) / (1 - peak)) ** 1.5)
    y = y * env * vel * 0.35
    pans = pan0 + (pan1 - pan0) * u
    a = (np.clip(pans, -1, 1) + 1) * np.pi / 4
    return np.stack([y * np.cos(a), y * np.sin(a)], 1).astype(np.float32) * np.sqrt(2)


def rumble(dur: float, vel: float = 0.6, f: float = 90) -> np.ndarray:
    n = samples(dur)
    t = np.arange(n) / SR
    y = lowpass(brown(n), f, 3) + 0.3 * lowpass(white(n), 300, 2)
    env = np.sin(np.pi * np.clip(t / dur, 0, 1)) ** 0.8
    return mono_to_stereo(y * env * vel * 0.4)


def sparkles(dur: float, count: int, f_lo: float = 2500, f_hi: float = 9000, vel: float = 0.5, seed: int = 3,
             density_curve=None, pan_spread: float = 0.9) -> np.ndarray:
    """Tiny crystalline pings scattered in time (density_curve(u) in 0..1)."""
    rng = np.random.default_rng(seed)
    n = samples(dur + 1.0)
    out = np.zeros((n, 2))
    for _ in range(count):
        u = rng.random()
        if density_curve is not None:
            # rejection sampling on the density curve
            for _k in range(20):
                if rng.random() < density_curve(u):
                    break
                u = rng.random()
        t = u * dur
        f = np.exp(rng.uniform(np.log(f_lo), np.log(f_hi)))
        L = samples(rng.uniform(0.15, 0.6))
        tt = np.arange(L) / SR
        p = np.sin(2 * np.pi * f * tt + rng.uniform(0, 6.28)) * np.exp(-tt / rng.uniform(0.05, 0.25))
        p *= np.clip(tt / 0.002, 0, 1)
        p = tail_fade(p, 0.3)
        i = samples(t)
        j = min(n, i + L)
        out[i:j] += mono_to_stereo(p * rng.uniform(0.3, 1.0), rng.uniform(-pan_spread, pan_spread))[: j - i]
    return (out * vel * 0.12).astype(np.float32)


def shimmer_gliss(dur: float, m0: float, m1: float, vel: float = 0.5, notes: int = 14, inst=synth.celesta, pan0=0.0,
                  pan1=0.0) -> np.ndarray:
    """A run of mallet notes gliding from m0 to m1 (pentatonic-ish steps)."""
    n = samples(dur + 3.0)
    out = np.zeros((n, 2))
    for k in range(notes):
        u = k / max(1, notes - 1)
        m = round(m0 + (m1 - m0) * u)
        y = inst(m, 2.5, vel * (0.6 + 0.4 * np.sin(np.pi * u)))
        i = samples(u * dur)
        j = min(n, i + len(y))
        out[i:j] += mono_to_stereo(y, pan0 + (pan1 - pan0) * u)[: j - i]
    return out.astype(np.float32)


# ---------------------------------------------------------------- glass
def glass_materialise(vel: float = 0.6, seed: int = 4) -> np.ndarray:
    rng = np.random.default_rng(seed)
    dur = 2.0
    n = samples(dur)
    t = np.arange(n) / SR
    y = np.zeros(n)
    for _ in range(18):
        f = rng.uniform(1800, 6500)
        rise = 1 + 0.06 * (t / 0.7)
        ph = 2 * np.pi * np.cumsum(f * rise) / SR
        env = np.clip(t / 0.6, 0, 1) ** 2 * np.exp(-np.maximum(t - 0.6, 0) / 0.35)
        y += np.sin(ph) * env * rng.uniform(0.2, 1.0)
    y /= 18
    ping = synth.glass_ping(rng.uniform(2200, 3000), 1.4, 0.8)
    i = samples(0.62)
    y[i : i + len(ping)] += ping[: n - i] * 1.2
    return mono_to_stereo(y * vel * 0.6)


def glass_knock(vel: float = 0.7, seed: int = 5) -> np.ndarray:
    rng = np.random.default_rng(seed)
    n = samples(0.6)
    t = np.arange(n) / SR
    tok = lowpass(white(n), 900, 2) * np.exp(-t / 0.012)
    ring = synth.glass_ping(rng.uniform(1500, 2100), 0.6, 0.5, bright=0.5)
    y = tok * 0.8 + ring[:n]
    return y * vel


def glass_crack(vel: float = 0.9, seed: int = 6) -> np.ndarray:
    rng = np.random.default_rng(seed)
    dur = 1.2
    n = samples(dur)
    t = np.arange(n) / SR
    y = highpass(white(n), 1500, 2) * np.exp(-t / 0.006) * 1.2
    # a crackling run of micro-fractures
    for k in range(26):
        tk = 0.004 + k * rng.uniform(0.004, 0.018)
        L = samples(0.004)
        i = samples(tk)
        if i + L < n:
            y[i : i + L] += highpass(white(L), 3000, 2) * rng.uniform(0.3, 1.0) * np.exp(-k / 12)
    for _ in range(7):
        p = synth.glass_ping(rng.uniform(2500, 7500), 0.9, 0.7)
        i = samples(rng.uniform(0.0, 0.2))
        y[i : i + len(p)] += p[: n - i] * rng.uniform(0.4, 0.9)
    return y * vel


def glass_shatter(slowmo: float = 1.0, vel: float = 1.0, seed: int = 7, dur: float = 3.2) -> np.ndarray:
    """Impact, a cloud of shards, then scattered landings. `slowmo` > 1 stretches the cloud."""
    rng = np.random.default_rng(seed)
    n = samples(dur)
    t = np.arange(n) / SR
    out = np.zeros((n, 2))
    imp = highpass(white(n), 800, 2) * np.exp(-t / 0.03) * 1.2 + lowpass(white(n), 600, 2) * np.exp(-t / 0.05) * 0.8
    out += mono_to_stereo(imp)
    count = 420
    for _ in range(count):
        u = rng.random() ** 1.8
        tk = u * 1.4 * slowmo
        f = np.exp(rng.uniform(np.log(1800), np.log(11000)))
        p = synth.glass_ping(f, rng.uniform(0.15, 0.7), rng.uniform(0.2, 0.9), bright=rng.uniform(0.3, 1))
        i = samples(tk)
        if i >= n:
            continue
        j = min(n, i + len(p))
        out[i:j] += mono_to_stereo(p[: j - i], rng.uniform(-1, 1)) * (1 - 0.6 * u)
    # landings on the ground (duller, later)
    for _ in range(70):
        tk = 1.3 * slowmo + rng.uniform(0, 1.2)
        f = rng.uniform(1200, 4200)
        p = synth.glass_ping(f, 0.25, 0.5, bright=0.3)
        i = samples(tk)
        if i >= n:
            continue
        j = min(n, i + len(p))
        out[i:j] += mono_to_stereo(p[: j - i], rng.uniform(-1, 1)) * 0.5
    out = highpass(out, 150, 2)
    return (out * vel * 0.35).astype(np.float32)


# ---------------------------------------------------------------- paper, steps, objects
def paper_flight(dur: float, pan0: float, pan1: float, vel: float = 0.5, seed: int = 8) -> np.ndarray:
    rng = np.random.default_rng(seed)
    n = samples(dur)
    t = np.arange(n) / SR
    u = t / dur
    flutter = 0.55 + 0.45 * np.sin(2 * np.pi * rng.uniform(18, 26) * t + np.sin(2 * np.pi * 3 * t))
    air = bandpass(white(n), 900, 4200, 2) * flutter
    air += 0.6 * bandpass(pink(n), 300, 1400, 2)
    env = np.sin(np.pi * u) ** 0.7
    y = air * env * vel * 0.18
    pans = pan0 + (pan1 - pan0) * u
    a = (np.clip(pans, -1, 1) + 1) * np.pi / 4
    return np.stack([y * np.cos(a), y * np.sin(a)], 1).astype(np.float32) * np.sqrt(2)


def paper_throw(vel: float = 0.6) -> np.ndarray:
    n = samples(0.25)
    t = np.arange(n) / SR
    c = 600 * (6 ** (t / 0.25))
    y = sweep_filter(white(n), c, width_oct=1.5) * np.sin(np.pi * t / 0.25) ** 0.6
    return y * vel * 0.4


def paper_tap(vel: float = 0.5) -> np.ndarray:
    n = samples(0.12)
    t = np.arange(n) / SR
    y = bandpass(white(n), 1200, 5000, 2) * np.exp(-t / 0.01) + bandpass(white(n), 300, 900, 2) * np.exp(-t / 0.02) * 0.5
    return y * vel * 0.5


def footstep_grass(vel: float = 0.5, seed: int = 9) -> np.ndarray:
    rng = np.random.default_rng(seed)
    n = samples(0.28)
    t = np.arange(n) / SR
    y = np.zeros(n)
    for k in range(8):
        i = samples(rng.uniform(0, 0.08))
        L = samples(rng.uniform(0.01, 0.04))
        if i + L < n:
            y[i : i + L] += bandpass(white(L), 1500, 7000, 2) * rng.uniform(0.2, 1.0)
    y += lowpass(white(n), 250, 2) * np.exp(-t / 0.03) * 0.8
    return y * vel * 0.5


def thud(vel: float = 0.6, f: float = 120, dur: float = 0.5) -> np.ndarray:
    n = samples(dur)
    t = np.arange(n) / SR
    y = np.sin(2 * np.pi * f * t * (1 + 0.6 * np.exp(-t / 0.02))) * np.exp(-t / 0.08)
    y += lowpass(white(n), 700, 2) * np.exp(-t / 0.015) * 0.6
    return tail_fade(y * vel * 0.7, 0.3)


def clock_tick(high: bool = True, vel: float = 0.5) -> np.ndarray:
    n = samples(0.08)
    t = np.arange(n) / SR
    f = 2800 if high else 2300
    y = resonator(white(n) * np.exp(-t / 0.002), f, 12) * 2 + resonator(white(n) * np.exp(-t / 0.003), f * 0.5, 6)
    return y * vel * 0.6


def lantern_catch(vel: float = 0.6, seed: int = 10) -> np.ndarray:
    """A small flame catching: breath of air, then a warm low bloom."""
    n = samples(1.6)
    t = np.arange(n) / SR
    puff = lowpass(white(n), 1400, 2) * np.exp(-t / 0.06) * 0.7
    bloom = np.sin(2 * np.pi * 110 * t) * 0.4 + np.sin(2 * np.pi * 220 * t) * 0.2 + np.sin(2 * np.pi * 330 * t) * 0.08
    bloom *= np.clip(t / 0.15, 0, 1) * np.exp(-t / 0.7)
    return tail_fade((puff + bloom) * vel * 0.6, 0.3)


def dim_down(vel: float = 0.6, f0: float = 420, f1: float = 110, dur: float = 0.9) -> np.ndarray:
    n = samples(dur)
    t = np.arange(n) / SR
    f = f1 + (f0 - f1) * np.exp(-t / (dur / 3))
    ph = 2 * np.pi * np.cumsum(f) / SR
    y = (np.sin(ph) + 0.35 * np.sin(2 * ph) + 0.15 * np.sin(3 * ph)) * np.exp(-t / (dur / 2.5)) * np.clip(t / 0.01, 0, 1)
    y = lowpass(y, 1200, 2)
    return tail_fade(y * vel * 0.4, 0.3)


def warning_hum(dur: float, vel: float = 0.5) -> np.ndarray:
    """The dependency chain: a taut, faintly beating tone with a buzz."""
    n = samples(dur)
    t = np.arange(n) / SR
    y = np.zeros(n)
    for f, a in [(146.8, 0.5), (155.6, 0.35), (1174.7, 0.18), (1244.5, 0.14)]:
        y += a * np.sin(2 * np.pi * f * t)
    saw = ((t * 73.4) % 1.0) * 2 - 1
    y += 0.25 * bandpass(saw, 600, 2400, 2)
    env = np.clip(t / 0.4, 0, 1) * np.clip((dur - t) / 0.6, 0, 1)
    return mono_to_stereo(y * env * vel * 0.25)


def zing(vel: float = 0.6) -> np.ndarray:
    n = samples(1.4)
    t = np.arange(n) / SR
    y = np.zeros(n)
    for f in [1760, 1777, 2637, 2661]:
        y += np.sin(2 * np.pi * f * t) * np.exp(-t / 0.45)
    y += highpass(white(n), 3000, 2) * np.exp(-t / 0.02) * 0.6
    return tail_fade(y * vel * 0.2, 0.3)


def root_pulse(vel: float = 0.6) -> np.ndarray:
    n = samples(1.2)
    t = np.arange(n) / SR
    y = np.sin(2 * np.pi * 46 * t * (1 + 0.3 * np.exp(-t / 0.05))) * np.exp(-t / 0.35) * np.clip(t / 0.01, 0, 1)
    y += 0.3 * np.sin(2 * np.pi * 92 * t) * np.exp(-t / 0.2)
    return tail_fade(np.tanh(y * 1.4) * vel * 0.7, 0.3)


def wood_creak(dur: float = 1.2, vel: float = 0.4, seed: int = 11) -> np.ndarray:
    rng = np.random.default_rng(seed)
    n = samples(dur)
    t = np.arange(n) / SR
    rate = 60 + 50 * np.sin(np.pi * t / dur) + rng.uniform(-10, 10)
    pulses = (np.sin(2 * np.pi * np.cumsum(rate) / SR) > 0.96).astype(float)
    y = resonator(pulses * white(n), 420 + rng.uniform(-60, 60), 8) + resonator(pulses * white(n), 1100, 10) * 0.4
    return y * np.sin(np.pi * t / dur) * vel * 0.8


def rustle(dur: float, vel: float = 0.4, seed: int = 12) -> np.ndarray:
    rng = np.random.default_rng(seed)
    n = samples(dur)
    t = np.arange(n) / SR
    am = np.abs(lowpass(white(n), 25, 2)) * 6
    y = bandpass(white(n), 2500, 9000, 2) * am
    env = np.sin(np.pi * t / dur) ** 0.5
    return mono_to_stereo(y * env * vel * 0.25, rng.uniform(-0.4, 0.4))


def pop(vel: float = 0.5, f: float = 700) -> np.ndarray:
    n = samples(0.3)
    t = np.arange(n) / SR
    fr = f * (1 + 1.5 * np.exp(-t / 0.012))
    y = np.sin(2 * np.pi * np.cumsum(fr) / SR) * np.exp(-t / 0.05)
    return y * vel * 0.5
