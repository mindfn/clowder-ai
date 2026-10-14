// A camera rig: build the scene once as a "world" at composition size, then frame it.
// Moves are discrete: hold, travel with ease.move, hold again. There is no drift API on
// purpose; a slow continuous zoom on every shot is the failure this rig exists to prevent.
import type { FC, ReactNode } from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import { dur, ease } from './motion';

// The world point (x, y) placed at the centre of the frame, and the magnification.
export type Framing = { x: number; y: number; zoom: number };
// Hold the previous framing until `start`, travel for `length` frames, then hold `to`.
export type Move = { start: number; to: Framing; length?: number };

export const wide = (width: number, height: number): Framing => ({
  x: width / 2,
  y: height / 2,
  zoom: 1,
});

export const framingAt = (frame: number, initial: Framing, moves: Move[]): Framing => {
  let current = initial;
  for (const move of moves) {
    if (frame < move.start) break;
    const length = move.length ?? dur.move;
    const p = interpolate(frame, [move.start, move.start + length], [0, 1], {
      easing: ease.move,
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
    });
    const from = current;
    current = {
      x: from.x + (move.to.x - from.x) * p,
      y: from.y + (move.to.y - from.y) * p,
      // Zoom travels in log space so a 1→4 push feels even instead of front-loaded.
      zoom: Math.exp(Math.log(from.zoom) + (Math.log(move.to.zoom) - Math.log(from.zoom)) * p),
    };
    if (p < 1) break;
  }
  return current;
};

export const Camera: FC<{ initial: Framing; moves: Move[]; children: ReactNode }> = ({ initial, moves, children }) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const { x, y, zoom } = framingAt(frame, initial, moves);
  return (
    <AbsoluteFill style={{ overflow: 'hidden' }}>
      <div
        style={{
          position: 'absolute',
          width,
          height,
          transformOrigin: '0 0',
          // No will-change: it makes Chrome rasterise once and scale the bitmap, which blurs text.
          transform: `translate(${width / 2}px, ${height / 2}px) scale(${zoom}) translate(${-x}px, ${-y}px)`,
        }}
      >
        {children}
      </div>
    </AbsoluteFill>
  );
};
