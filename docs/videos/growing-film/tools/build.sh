#!/usr/bin/env bash
# Build the Growing film end to end:
#   canon sprites -> event tables -> picture (60 fps) -> score + sound design -> mux.
# Outputs: out/growing-master.mp4 (archive quality) and out/growing-share.mp4 (smaller).
set -euo pipefail
cd "$(dirname "$0")/.."

PY=.venv/bin/python
if [[ ! -x $PY ]]; then
  uv venv -q .venv
  uv pip install -q --python .venv/bin/python numpy scipy pillow
fi

[[ -f build/cats/manifest.json ]] || $PY tools/prepare_cats.py
mkdir -p build/brand
cp -n "${CANON_SITE:-/Users/lang/workspace/github-lab/clowder-ai-roadmap-growing-tree/site}/assets/logo-transparent.png" build/brand/mark.png 2>/dev/null || true

node tools/export-events.mjs
node tools/render.mjs video --from 0 --to 122.5 --fps 60 --preset slow --crf 14 --out out/picture-60fps.mp4
$PY audio/mix.py

ffmpeg -v error -y -i out/picture-60fps.mp4 -i build/audio/growing-mix.wav \
  -map 0:v -map 1:a -c:v copy -c:a aac -b:a 320k -movflags +faststart -shortest out/growing-master.mp4
ffmpeg -v error -y -i out/picture-60fps.mp4 -i build/audio/growing-mix.wav \
  -map 0:v -map 1:a -c:v libx264 -preset slow -crf 21 -pix_fmt yuv420p -c:a aac -b:a 192k \
  -movflags +faststart -shortest out/growing-share.mp4
ls -lh out/growing-master.mp4 out/growing-share.mp4
