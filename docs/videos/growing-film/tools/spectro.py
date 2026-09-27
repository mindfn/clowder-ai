"""Spectrogram + loudness strip of a mix, with cue markers, as a PNG.

    python tools/spectro.py build/audio/growing-mix.wav out/spectro.png [t0 t1]
"""

import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from scipy import signal
from scipy.io import wavfile

ROOT = Path(__file__).resolve().parent.parent


def main():
    src, dst = sys.argv[1], sys.argv[2]
    sr, x = wavfile.read(src)
    x = x.astype(np.float32)
    if x.ndim > 1:
        x = x.mean(1)
    t0 = float(sys.argv[3]) if len(sys.argv) > 3 else 0.0
    t1 = float(sys.argv[4]) if len(sys.argv) > 4 else len(x) / sr
    x = x[int(t0 * sr) : int(t1 * sr)]
    W, H = 2400, 520
    f, t, Z = signal.stft(x, fs=sr, nperseg=4096, noverlap=4096 - int(sr * (t1 - t0) / W))
    mag = 20 * np.log10(np.abs(Z) + 1e-7)
    # log-frequency rows 30 Hz .. 16 kHz
    rows = np.geomspace(30, 16000, H)
    idx = np.clip(np.searchsorted(f, rows), 0, len(f) - 1)
    img = mag[idx][::-1]
    img = np.clip((img + 110) / 90, 0, 1)
    cols = np.linspace(0, img.shape[1] - 1, W).astype(int)
    img = img[:, cols]
    r = np.clip(img * 1.6, 0, 1)
    g = np.clip(img * 1.6 - 0.5, 0, 1)
    b = np.clip(0.3 + img * 0.7 - np.clip(img * 2 - 1.2, 0, 1), 0, 1)
    rgb = (np.stack([r, g, b], -1) * 255).astype(np.uint8)
    im = Image.fromarray(rgb)
    # loudness strip
    strip = Image.new("RGB", (W, 120), (10, 10, 16))
    d = ImageDraw.Draw(strip)
    hop = max(1, len(x) // W)
    for i in range(W):
        seg = x[i * hop : (i + 1) * hop]
        if len(seg) == 0:
            continue
        rms = 20 * np.log10(np.sqrt(np.mean(seg ** 2)) + 1e-9)
        pk = 20 * np.log10(np.max(np.abs(seg)) + 1e-9)
        yr = int(np.clip(-rms, 0, 60) * 2)
        yp = int(np.clip(-pk, 0, 60) * 2)
        d.line([(i, 119), (i, yr)], fill=(80, 170, 255))
        d.point((i, yp), fill=(255, 90, 90))
    out = Image.new("RGB", (W, H + 120 + 22), (0, 0, 0))
    out.paste(im, (0, 0))
    out.paste(strip, (0, H))
    dd = ImageDraw.Draw(out)
    cues = json.loads((ROOT / "timeline.json").read_text())["cues"]
    for k, v in cues.items():
        if t0 <= v <= t1:
            xpx = int((v - t0) / (t1 - t0) * W)
            dd.line([(xpx, 0), (xpx, H + 120)], fill=(255, 255, 255), width=1)
            dd.text((xpx + 2, H + 122), k[:9], fill=(255, 255, 160))
    for s in range(int(t0), int(t1) + 1):
        xpx = int((s - t0) / (t1 - t0) * W)
        if s % 3 == 0:
            dd.line([(xpx, H), (xpx, H + 8)], fill=(200, 200, 200))
    out.save(dst)


if __name__ == "__main__":
    main()
