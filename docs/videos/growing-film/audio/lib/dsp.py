"""DSP core: a stereo timeline to render into, envelopes, filters, reverbs and
the master chain. Everything is numpy/scipy; signals are float32 stereo
arrays shaped (n, 2) at SR.
"""

from __future__ import annotations

import numpy as np
from scipy import signal

SR = 48000
RNG = np.random.default_rng(20260927)


def secs(n: int) -> float:
    return n / SR


def samples(t: float) -> int:
    return int(round(t * SR))


class Track:
    """A stereo bus you can add clips into at arbitrary times."""

    def __init__(self, duration: float, name: str = "track"):
        self.name = name
        self.buf = np.zeros((samples(duration) + 1, 2), dtype=np.float32)

    def add(self, clip: np.ndarray, t: float, gain: float = 1.0, pan: float = 0.0):
        if clip is None or len(clip) == 0:
            return
        if clip.ndim == 1:
            clip = mono_to_stereo(clip, pan)
        elif pan:
            clip = clip * pan_gains(pan)[None, :]
        i0 = samples(t)
        if i0 < 0:
            clip = clip[-i0:]
            i0 = 0
        i1 = min(len(self.buf), i0 + len(clip))
        if i1 <= i0:
            return
        self.buf[i0:i1] += (clip[: i1 - i0] * gain).astype(np.float32)


def pan_gains(pan: float) -> np.ndarray:
    """Equal-power pan, -1 (left) .. 1 (right)."""
    a = (np.clip(pan, -1, 1) + 1) * np.pi / 4
    return np.array([np.cos(a), np.sin(a)], dtype=np.float32) * np.sqrt(2)


def mono_to_stereo(x: np.ndarray, pan: float = 0.0) -> np.ndarray:
    g = pan_gains(pan)
    return np.stack([x * g[0], x * g[1]], axis=1).astype(np.float32)


def t_axis(dur: float) -> np.ndarray:
    return np.arange(samples(dur), dtype=np.float64) / SR


# ---------------------------------------------------------------- envelopes
def adsr(n: int, a: float, d: float, s: float, r: float, hold: float | None = None) -> np.ndarray:
    """Attack/decay/sustain/release over n samples; release starts at `hold` s
    (defaults to n - r)."""
    t = np.arange(n) / SR
    total = n / SR
    rel_at = (total - r) if hold is None else hold
    env = np.empty(n, dtype=np.float64)
    a = max(a, 1e-4)
    env[:] = s
    m = t < a
    env[m] = t[m] / a
    m = (t >= a) & (t < a + d)
    if d > 0:
        env[m] = 1 - (1 - s) * (t[m] - a) / d
    lvl = np.interp(rel_at, t, env) if rel_at < total else s
    m = t >= rel_at
    env[m] = lvl * np.clip(1 - (t[m] - rel_at) / max(r, 1e-4), 0, 1)
    return env


def expdecay(n: int, tau: float, attack: float = 0.002) -> np.ndarray:
    t = np.arange(n) / SR
    env = np.exp(-t / max(tau, 1e-4))
    if attack > 0:
        env *= np.clip(t / attack, 0, 1)
    return env


def fade(x: np.ndarray, fin: float = 0.0, fout: float = 0.0) -> np.ndarray:
    x = x.copy()
    n = len(x)
    if fin > 0:
        k = min(n, samples(fin))
        w = np.sin(np.linspace(0, np.pi / 2, k)) ** 2
        x[:k] *= w if x.ndim == 1 else w[:, None]
    if fout > 0:
        k = min(n, samples(fout))
        w = np.cos(np.linspace(0, np.pi / 2, k)) ** 2
        x[n - k :] *= w if x.ndim == 1 else w[:, None]
    return x


def curve(n: int, points: list[tuple[float, float]]) -> np.ndarray:
    """Piecewise-linear automation over n samples from (time, value) pairs."""
    ts = np.array([p[0] for p in points])
    vs = np.array([p[1] for p in points])
    return np.interp(np.arange(n) / SR, ts, vs)


# ---------------------------------------------------------------- filters
def _sos(kind: str, f, order: int = 2):
    return signal.butter(order, np.array(f) / (SR / 2), btype=kind, output="sos")


def lowpass(x, f, order=2):
    return signal.sosfilt(_sos("lowpass", min(f, SR * 0.49), order), x, axis=0)


def highpass(x, f, order=2):
    return signal.sosfilt(_sos("highpass", f, order), x, axis=0)


def bandpass(x, lo, hi, order=2):
    return signal.sosfilt(_sos("bandpass", [lo, min(hi, SR * 0.49)], order), x, axis=0)


def peaking(x, f0, gain_db, q=1.0):
    """RBJ peaking EQ."""
    A = 10 ** (gain_db / 40)
    w = 2 * np.pi * f0 / SR
    alpha = np.sin(w) / (2 * q)
    b = [1 + alpha * A, -2 * np.cos(w), 1 - alpha * A]
    a = [1 + alpha / A, -2 * np.cos(w), 1 - alpha / A]
    return signal.lfilter(np.array(b) / a[0], np.array(a) / a[0], x, axis=0)


def shelf(x, f0, gain_db, high=True):
    A = 10 ** (gain_db / 40)
    w = 2 * np.pi * f0 / SR
    cs = np.cos(w)
    alpha = np.sin(w) / 2 * np.sqrt(2)
    sq = 2 * np.sqrt(A) * alpha
    if high:
        b = [A * ((A + 1) + (A - 1) * cs + sq), -2 * A * ((A - 1) + (A + 1) * cs), A * ((A + 1) + (A - 1) * cs - sq)]
        a = [(A + 1) - (A - 1) * cs + sq, 2 * ((A - 1) - (A + 1) * cs), (A + 1) - (A - 1) * cs - sq]
    else:
        b = [A * ((A + 1) - (A - 1) * cs + sq), 2 * A * ((A - 1) - (A + 1) * cs), A * ((A + 1) - (A - 1) * cs - sq)]
        a = [(A + 1) + (A - 1) * cs + sq, -2 * ((A - 1) + (A + 1) * cs), (A + 1) + (A - 1) * cs - sq]
    return signal.lfilter(np.array(b) / a[0], np.array(a) / a[0], x, axis=0)


def resonator(x, f0, q):
    """Two-pole resonant bandpass (constant 0 dB peak)."""
    w = 2 * np.pi * f0 / SR
    alpha = np.sin(w) / (2 * q)
    b = [alpha, 0, -alpha]
    a = [1 + alpha, -2 * np.cos(w), 1 - alpha]
    return signal.lfilter(np.array(b) / a[0], np.array(a) / a[0], x, axis=0)


def sweep_filter(x: np.ndarray, centers: np.ndarray, width_oct: float = 1.0, nfft: int = 2048) -> np.ndarray:
    """Time-varying spectral bandpass: `centers` (Hz) sampled per output sample.
    Implemented in the STFT domain with a Gaussian (in log-frequency) mask."""
    mono = x.ndim == 1
    X = x[:, None] if mono else x
    hop = nfft // 4
    f, tt, Z = signal.stft(X.T, fs=SR, nperseg=nfft, noverlap=nfft - hop, boundary='zeros', padded=True)
    frames = Z.shape[-1]
    idx = np.clip((tt * SR).astype(int), 0, len(centers) - 1)
    c = centers[idx]
    lf = np.log2(np.maximum(f, 1.0))[:, None]
    mask = np.exp(-0.5 * ((lf - np.log2(np.maximum(c, 1.0))[None, :]) / (width_oct / 2.355)) ** 2)
    Z = Z * mask[None, :, :frames]
    _, y = signal.istft(Z, fs=SR, nperseg=nfft, noverlap=nfft - hop, boundary=True)
    y = y.T[: len(x)]
    if len(y) < len(x):
        y = np.pad(y, ((0, len(x) - len(y)), (0, 0)))
    return y[:, 0] if mono else y


# ---------------------------------------------------------------- noise
def white(n: int) -> np.ndarray:
    return RNG.standard_normal(n)


def pink(n: int) -> np.ndarray:
    """Voss-McCartney-ish pink noise via spectral shaping."""
    w = RNG.standard_normal(n)
    W = np.fft.rfft(w)
    f = np.fft.rfftfreq(n, 1 / SR)
    W /= np.sqrt(np.maximum(f, 20.0))
    y = np.fft.irfft(W, n)
    return y / (np.std(y) + 1e-12)


def brown(n: int) -> np.ndarray:
    y = np.cumsum(RNG.standard_normal(n))
    y = highpass(y, 15, 1)
    return y / (np.std(y) + 1e-12)


# ---------------------------------------------------------------- reverb
def make_ir(rt60_low: float, rt60_high: float, length: float, predelay: float = 0.02, seed: int = 1,
            early: int = 10, width: float = 1.0, damp_hz: float = 7000) -> np.ndarray:
    """Stereo diffuse IR with frequency-dependent decay: low bands ring longer."""
    rng = np.random.default_rng(seed)
    n = samples(length)
    t = np.arange(n) / SR
    bands = [(20, 250), (250, 800), (800, 2500), (2500, 7000), (7000, 20000)]
    rts = np.geomspace(rt60_low, rt60_high, len(bands))
    ir = np.zeros((n, 2))
    for ch in range(2):
        noise = rng.standard_normal(n)
        acc = np.zeros(n)
        for (lo, hi), rt in zip(bands, rts):
            b = bandpass(noise, lo, min(hi, SR * 0.45), 2)
            acc += b * np.exp(-6.91 * t / rt)
        ir[:, ch] = acc
    # soft onset of the tail, then predelay
    ir *= (1 - np.exp(-t / 0.012))[:, None]
    ir = lowpass(ir, damp_hz, 1)
    pd = samples(predelay)
    ir = np.concatenate([np.zeros((pd, 2)), ir])[:n]
    # early reflections
    for k in range(early):
        d = samples(predelay * 0.4 + rng.uniform(0.004, 0.06))
        g = rng.uniform(0.2, 0.6) * (0.85 ** k)
        ch = k % 2
        if d < n:
            ir[d, ch] += g * 3
    # decorrelate / width
    mid = (ir[:, 0] + ir[:, 1]) / 2
    side = (ir[:, 0] - ir[:, 1]) / 2 * width
    ir = np.stack([mid + side, mid - side], 1)
    ir /= np.sqrt(np.sum(ir ** 2) / 2) + 1e-12
    return ir.astype(np.float32)


def convolve(x: np.ndarray, ir: np.ndarray) -> np.ndarray:
    """Stereo in, stereo IR: L->L,R->R (true-stereo would double the cost)."""
    out = np.zeros((len(x) + len(ir) - 1, 2), dtype=np.float32)
    for ch in range(2):
        out[:, ch] = signal.oaconvolve(x[:, ch], ir[:, ch], mode="full")
    return out[: len(x)]


# ---------------------------------------------------------------- dynamics
def envelope_follow(x: np.ndarray, attack: float, release: float, block: int = 48) -> np.ndarray:
    """Block-wise peak follower (per block of `block` samples), returns per-sample."""
    mono = np.max(np.abs(x), axis=1) if x.ndim == 2 else np.abs(x)
    nb = int(np.ceil(len(mono) / block))
    pad = np.pad(mono, (0, nb * block - len(mono)))
    peaks = pad.reshape(nb, block).max(axis=1)
    ga = np.exp(-block / (SR * max(attack, 1e-5)))
    gr = np.exp(-block / (SR * max(release, 1e-5)))
    env = np.empty(nb)
    e = 0.0
    for i, p in enumerate(peaks):
        g = ga if p > e else gr
        e = g * e + (1 - g) * p
        env[i] = e
    return np.repeat(env, block)[: len(mono)]


def compress(x: np.ndarray, thresh_db: float = -18, ratio: float = 2.0, attack: float = 0.02,
             release: float = 0.25, knee_db: float = 6, makeup_db: float = 0.0) -> np.ndarray:
    env = envelope_follow(x, attack, release)
    lvl = 20 * np.log10(env + 1e-9)
    over = lvl - thresh_db
    gr = np.where(over <= -knee_db / 2, 0.0,
                  np.where(over >= knee_db / 2, over * (1 - 1 / ratio),
                           (1 - 1 / ratio) * (over + knee_db / 2) ** 2 / (2 * knee_db)))
    g = 10 ** ((-gr + makeup_db) / 20)
    return (x * g[:, None]).astype(np.float32)


def limit(x: np.ndarray, ceiling_db: float = -1.0, lookahead: float = 0.005, release: float = 0.12) -> np.ndarray:
    """Look-ahead brickwall-ish peak limiter."""
    c = 10 ** (ceiling_db / 20)
    la = samples(lookahead)
    peak = np.max(np.abs(x), axis=1)
    # running max over the look-ahead window
    from scipy.ndimage import maximum_filter1d

    pk = maximum_filter1d(peak, size=2 * la + 1, origin=0)
    need = np.minimum(1.0, c / np.maximum(pk, 1e-9))
    # smooth: instant attack (already looked ahead), exponential release
    block = 16
    nb = int(np.ceil(len(need) / block))
    pad = np.pad(need, (0, nb * block - len(need)), constant_values=1.0)
    mins = pad.reshape(nb, block).min(axis=1)
    gr = np.exp(-block / (SR * release))
    g = np.empty(nb)
    cur = 1.0
    for i, m in enumerate(mins):
        cur = m if m < cur else gr * cur + (1 - gr) * m
        g[i] = cur
    gain = np.repeat(g, block)[: len(need)]
    gain = np.minimum(gain, need + 0.0)  # never exceed what the peak needs
    y = x * gain[:, None]
    return np.clip(y, -c, c).astype(np.float32)


def soft_clip(x: np.ndarray, drive: float = 1.0) -> np.ndarray:
    return np.tanh(x * drive) / np.tanh(drive)


def stereo_widen(x: np.ndarray, amount: float) -> np.ndarray:
    mid = (x[:, 0] + x[:, 1]) / 2
    side = (x[:, 0] - x[:, 1]) / 2 * amount
    return np.stack([mid + side, mid - side], 1).astype(np.float32)


def haas(x: np.ndarray, ms: float = 12, side: int = 1) -> np.ndarray:
    """Delay one channel slightly for width on mono sources."""
    d = samples(ms / 1000)
    y = x.copy()
    ch = 1 if side > 0 else 0
    y[:, ch] = np.concatenate([np.zeros(d), x[:-d, ch]]) if d else x[:, ch]
    return y


def db(x: float) -> float:
    return 10 ** (x / 20)


def midi_hz(m: float) -> float:
    return 440.0 * 2 ** ((m - 69) / 12)


NOTE_INDEX = {"C": 0, "C#": 1, "Db": 1, "D": 2, "D#": 3, "Eb": 3, "E": 4, "F": 5, "F#": 6, "Gb": 6,
              "G": 7, "G#": 8, "Ab": 8, "A": 9, "A#": 10, "Bb": 10, "B": 11}


def nm(name: str) -> int:
    """'F#5' -> midi."""
    import re

    m = re.fullmatch(r"([A-G][#b]?)(-?\d)", name)
    if not m:
        raise ValueError(name)
    return 12 * (int(m.group(2)) + 1) + NOTE_INDEX[m.group(1)]


# ---------------------------------------------------------------- loudness (ITU-R BS.1770-4)
def lufs(x: np.ndarray) -> float:
    """Integrated loudness of a stereo 48 kHz signal."""
    b1 = [1.53512485958697, -2.69169618940638, 1.19839281085285]
    a1 = [1.0, -1.69065929318241, 0.73248077421585]
    b2 = [1.0, -2.0, 1.0]
    a2 = [1.0, -1.99004745483398, 0.99007225036621]
    y = signal.lfilter(b2, a2, signal.lfilter(b1, a1, x, axis=0), axis=0)
    blk = int(0.4 * SR)
    hop = int(0.1 * SR)
    ms = []
    for i in range(0, len(y) - blk, hop):
        seg = y[i : i + blk]
        ms.append(np.sum(np.mean(seg ** 2, axis=0)))
    ms = np.array(ms)
    L = -0.691 + 10 * np.log10(ms + 1e-12)
    gated = ms[L > -70]
    if len(gated) == 0:
        return -70.0
    rel = -0.691 + 10 * np.log10(np.mean(gated)) - 10
    g2 = ms[(L > -70) & (L > rel)]
    return float(-0.691 + 10 * np.log10(np.mean(g2)))


def true_peak_db(x: np.ndarray) -> float:
    up = signal.resample_poly(x, 4, 1, axis=0)
    return float(20 * np.log10(np.max(np.abs(up)) + 1e-12))
