#!/usr/bin/env python3
"""Find the moments in a music track worth cutting on.

Many tracks (ambient, cinematic, generated) have no steady, known BPM, so "cut on the
beat" needs measured onsets instead. This prints the strongest onsets as composition
frames, plus tempo candidates when the track does have a pulse.

Usage:
  python3 music-cues.py <audio> [--fps 30] [--top 24] [--min-gap-ms 300] [--start-ms 0] [--end-ms N]

Output (stdout, JSON):
  {"fps": 30, "durationMs": ..., "tempoCandidates": [bpm, ...],
   "onsets": [{"ms": 950, "frame": 28, "strength": 3.1}, ...]}   # sorted by time

Needs ffmpeg on PATH and numpy.
"""

import argparse
import json
import subprocess
import sys

import numpy as np

SR = 11025
HOP = 256


def decode(path: str) -> np.ndarray:
    try:
        raw = subprocess.run(
            ["ffmpeg", "-v", "error", "-i", path, "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"],
            check=True,
            capture_output=True,
        ).stdout
    except FileNotFoundError:
        sys.exit("music-cues: ffmpeg not found on PATH")
    except subprocess.CalledProcessError as err:
        sys.exit(f"music-cues: ffmpeg could not decode {path}: {err.stderr.decode(errors='replace').strip()}")
    samples = np.frombuffer(raw, dtype=np.float32)
    if samples.size < SR:
        sys.exit(f"music-cues: {path} is shorter than one second; nothing to analyse")
    return samples


def onset_strength(samples: np.ndarray) -> np.ndarray:
    n = len(samples) // HOP
    frames = samples[: n * HOP].reshape(n, HOP) * np.hanning(HOP)
    spectrum = np.log1p(np.abs(np.fft.rfft(frames, axis=1)))
    flux = np.maximum(0.0, np.diff(spectrum, axis=0)).sum(axis=1)
    return (flux - flux.mean()) / (flux.std() + 1e-9)


def tempo_candidates(flux: np.ndarray, hops_per_sec: float) -> list:
    ac = np.correlate(flux, flux, "full")[len(flux) - 1 :]
    scored = []
    for bpm in np.arange(60.0, 180.5, 0.5):
        lag = int(round(60.0 / bpm * hops_per_sec))
        if 2 * lag < len(ac):
            scored.append((ac[lag] + 0.5 * ac[2 * lag], float(bpm)))
    scored.sort(reverse=True)
    return [bpm for _, bpm in scored[:4]]


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("audio")
    ap.add_argument("--fps", type=int, default=30)
    ap.add_argument("--top", type=int, default=24, help="how many onsets to keep")
    ap.add_argument("--min-gap-ms", type=int, default=300, help="drop weaker onsets closer than this")
    ap.add_argument("--start-ms", type=int, default=0)
    ap.add_argument("--end-ms", type=int, default=None)
    args = ap.parse_args()

    samples = decode(args.audio)
    duration_ms = int(len(samples) / SR * 1000)
    flux = onset_strength(samples)
    hops_per_sec = SR / HOP

    end_ms = duration_ms if args.end_ms is None else min(args.end_ms, duration_ms)
    candidates = []
    for i in range(1, len(flux) - 1):
        # local peaks only
        if flux[i] > 1.0 and flux[i] >= flux[i - 1] and flux[i] >= flux[i + 1]:
            ms = int(round(i / hops_per_sec * 1000))
            if args.start_ms <= ms <= end_ms:
                candidates.append((float(flux[i]), ms))

    candidates.sort(reverse=True)
    kept = []
    for strength, ms in candidates:
        if all(abs(ms - k) >= args.min_gap_ms for _, k in kept):
            kept.append((strength, ms))
        if len(kept) >= args.top:
            break
    kept.sort(key=lambda item: item[1])

    print(
        json.dumps(
            {
                "fps": args.fps,
                "durationMs": duration_ms,
                "tempoCandidates": tempo_candidates(flux, hops_per_sec),
                "onsets": [
                    {"ms": ms, "frame": int(round(ms / 1000 * args.fps)), "strength": round(s, 2)} for s, ms in kept
                ],
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
