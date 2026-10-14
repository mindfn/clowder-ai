// Motion tokens for Remotion. Copy into the project (e.g. src/craft/) and import from there.
// Pick curves and durations by intent; do not invent a new bezier per shot.
import type { CSSProperties } from 'react';
import { Easing, interpolate } from 'remotion';

export const ease = {
  // Arrives fast, settles softly. Entrances, reveals, state changes landing.
  enter: Easing.bezier(0.16, 1, 0.3, 1),
  // Leaves decisively. Exits are shorter than entrances.
  exit: Easing.bezier(0.7, 0, 0.84, 0),
  // Travels between two rest positions. Camera moves, objects changing place.
  move: Easing.bezier(0.65, 0, 0.35, 1),
} as const;

// Starting values in frames at 30 fps. Convert with `at(fps, n)` for other frame rates.
export const dur = {
  enter: 15, // 0.5 s
  exit: 10, // 0.33 s
  move: 30, // 1 s; camera moves rarely need more than 45
  stagger: 4, // gap between siblings entering one after another
  settle: 18, // minimum hold after a reveal before the next primary action
} as const;

export const at = (fps: number, frames30: number) => Math.round((frames30 * fps) / 30);

// Clamped 0→1 progress of an action starting at `start` and lasting `length` frames.
export const progress = (frame: number, start: number, length: number, easing: (t: number) => number = ease.enter) =>
  interpolate(frame, [start, start + length], [0, 1], {
    easing,
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

// Entrance: rise a short distance while fading in. Opacity completes at 60 % of the
// move so the element never looks ghosted while it is still travelling.
export const rise = (p: number, distance = 24): CSSProperties => ({
  opacity: interpolate(p, [0, 0.6], [0, 1], { extrapolateRight: 'clamp' }),
  transform: `translateY(${(1 - p) * distance}px)`,
});
