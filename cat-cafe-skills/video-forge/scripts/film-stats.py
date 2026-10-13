#!/usr/bin/env python3
"""Put the same numbers on your cut and on a reference film before guessing why it feels like slides.

When someone says a film "looks like PPT", compare it against a reference they like first.
Stillness alone is rarely the cause: in 2026-10 a reference that felt fluid was 75 % still,
while our cut was 84 % still. What differed was scene hopping without a carrier (0 cuts vs 10)
and broken sound (1.2 % vs 41 % near-silent).

Usage:
  python3 film-stats.py <video> [<reference-video> ...] [--still 0.15] [--cut 25] [--silence-db -50]

Output (stdout, JSON list, one object per video, in argument order):
  [{"path": ..., "seconds": 65.0, "stillPct": 44.8, "cutCount": 8,
    "cutCandidates": [19.6, 24.2, ...], "silentPct": 1.6}]

- stillPct: share of neighbouring frame pairs whose mean absolute difference (192x108 gray,
  0-255) is below --still.
- cutCandidates: seconds where that difference jumps above --cut; jumps within 0.1 s of each
  other count once. Fast camera moves and whip pans land here too, so open each one and decide
  whether it is a real cut and whether something (a shape, a direction, an action, a sound)
  carries the viewer across it. The count is a prompt for looking, not a verdict.
- silentPct: share of 0.5 s windows quieter than --silence-db dBFS; a file without audio is 100.

Needs ffmpeg/ffprobe on PATH and numpy.
"""

import argparse
import json
import subprocess
import sys

import numpy as np

W, H = 192, 108
SR = 8000


def run(cmd: list) -> bytes:
    try:
        return subprocess.run(cmd, check=True, capture_output=True, stdin=subprocess.DEVNULL).stdout
    except FileNotFoundError:
        sys.exit("film-stats: ffmpeg/ffprobe not found on PATH")
    except subprocess.CalledProcessError as e:
        sys.exit(f"film-stats: {cmd[0]} failed: {e.stderr.decode(errors='replace').strip()[:300]}")


def parse_rate(text: str) -> float:
    """ffprobe prints "30/1", but some files add a trailing comma or a second line ("30/1,")."""
    first = text.strip().splitlines()[0].split(",")[0].strip() if text.strip() else ""
    num, _, den = first.partition("/")
    try:
        return float(num) / float(den or 1)
    except (ValueError, ZeroDivisionError):
        sys.exit(f"film-stats: cannot read the frame rate from ffprobe output {text!r}")


def fps_of(path: str) -> float:
    return parse_rate(run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=r_frame_rate", "-of", "csv=p=0", path]).decode())


def stats(path: str, still: float, cut: float, silence_db: float) -> dict:
    fps = fps_of(path)
    raw = run(["ffmpeg", "-v", "error", "-i", path, "-vf", f"scale={W}:{H},format=gray", "-f", "rawvideo", "-pix_fmt", "gray", "-"])
    frames = np.frombuffer(raw, dtype=np.uint8)
    frames = frames[: len(frames) // (W * H) * W * H].reshape(-1, H, W).astype(np.int16)
    diff = np.abs(np.diff(frames, axis=0)).mean(axis=(1, 2)) if len(frames) > 1 else np.zeros(0)

    jumps = np.where(diff > cut)[0]
    merged: list[float] = []
    last = -10**9
    for i in jumps:
        if i - last > max(1, round(0.1 * fps)):
            merged.append(round(float(i + 1) / fps, 2))
        last = i

    has_audio = bool(run(["ffprobe", "-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", path]).strip())
    audio = run(["ffmpeg", "-v", "error", "-i", path, "-vn", "-ac", "1", "-ar", str(SR), "-f", "s16le", "-"]) if has_audio else b""
    samples = np.frombuffer(audio, dtype=np.int16).astype(np.float64) / 32768
    win = SR // 2
    if len(samples) >= win:
        windows = samples[: len(samples) // win * win].reshape(-1, win)
        db = 20 * np.log10(np.sqrt((windows**2).mean(axis=1)) + 1e-9)
        silent = float((db < silence_db).mean() * 100)
    else:
        silent = 100.0

    return {
        "path": path,
        "seconds": round(len(frames) / fps, 2),
        "stillPct": round(float((diff < still).mean() * 100) if len(diff) else 100.0, 1),
        "cutCount": len(merged),
        "cutCandidates": merged,
        "silentPct": round(silent, 1),
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("videos", nargs="+")
    ap.add_argument("--still", type=float, default=0.15, help="below this mean frame difference a frame counts as still (default 0.15)")
    ap.add_argument("--cut", type=float, default=25, help="above this mean frame difference a frame is a cut candidate (default 25)")
    ap.add_argument("--silence-db", type=float, default=-50, help="0.5 s windows below this dBFS count as near-silent (default -50)")
    args = ap.parse_args()
    print(json.dumps([stats(v, args.still, args.cut, args.silence_db) for v in args.videos], ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
