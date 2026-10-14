#!/usr/bin/env bash
# Contact sheet: pull exact frames out of a rendered video and tile them into one image,
# so every beat's start, middle and end can be looked at side by side.
#
# Usage: contact-sheet.sh <video.mp4> <out.png> <frame> [<frame> ...]
#   Frames are 0-based composition frames (Remotion renders one video frame per composition frame).
#   Tiles appear in ascending frame order, left to right, top to bottom.
set -euo pipefail

if [ "$#" -lt 3 ]; then
  echo "usage: $0 <video.mp4> <out.png> <frame> [<frame> ...]" >&2
  exit 2
fi

video="$1"
out="$2"
shift 2

for f in "$@"; do
  case "$f" in
    '' | *[!0-9]*) echo "not a frame number: $f" >&2; exit 2 ;;
  esac
done

frames=$(printf '%s\n' "$@" | sort -n -u)
count=$(printf '%s\n' "$frames" | wc -l | tr -d ' ')
total=$(ffprobe -v error -count_packets -select_streams v:0 -show_entries stream=nb_read_packets -of default=noprint_wrappers=1:nokey=1 "$video")
last=$(printf '%s\n' "$frames" | tail -n 1)
if [ "$last" -ge "$total" ]; then
  echo "frame $last is past the end of $video ($total frames)" >&2
  exit 2
fi

expr=""
for f in $frames; do
  expr="${expr:+$expr+}eq(n\\,$f)"
done

cols=$(( count < 4 ? count : 4 ))
rows=$(( (count + cols - 1) / cols ))

ffmpeg -v error -y -i "$video" \
  -vf "select='${expr}',scale=640:-2,tile=${cols}x${rows}:padding=8:color=0x202020" \
  -frames:v 1 -fps_mode vfr "$out"

echo "$out: frames $(printf '%s ' $frames)(of $total)"
