// Text that enters through a mask: each line rises out of its own clipped box.
// Masked entrances read as deliberate; opacity fades read as cheap.
import type { CSSProperties, FC } from 'react';
import { useCurrentFrame } from 'remotion';
import { dur, ease, progress } from './motion';

export const Reveal: FC<{
  lines: string[];
  at: number; // frame the first line starts rising
  stagger?: number; // frames between lines
  length?: number; // frames each line takes
  style?: CSSProperties; // typography for the block
}> = ({ lines, at, stagger = 3, length = dur.enter, style }) => {
  const frame = useCurrentFrame();
  return (
    <div style={style}>
      {lines.map((line, i) => {
        const p = progress(frame, at + i * stagger, length, ease.enter);
        return (
          // Extra bottom padding keeps descenders inside the clip box.
          <div key={`${i}:${line}`} style={{ overflow: 'hidden', paddingBottom: '0.12em', marginBottom: '-0.12em' }}>
            <div style={{ transform: `translateY(${(1 - p) * 110}%)` }}>{line}</div>
          </div>
        );
      })}
    </div>
  );
};
