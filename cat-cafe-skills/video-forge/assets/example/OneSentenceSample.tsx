// Worked example: a 13 s film made from one sentence with this skill (2026-10-04).
// Brief: "用 13 秒说清：Clowder AI 的猫，会记得和你一起做过的事。"
// Treatment: remembered line = "它们记得。"; world = kinetic type, borrowing one chat exchange;
// rhythm = onsets of the music bed (scripts/music-cues.py); palette = one dark, one ink, one amber;
// motion = crisp. Line 3 is the carrier: it flies into place and becomes the message you sent.
// Register: <Composition id="OneSentenceSample" component={OneSentenceSample}
//            width={1920} height={1080} fps={30} durationInFrames={390} />
// The music file is the workbench's public/bgm track; swap in your own.

import { loadFont } from '@remotion/google-fonts/NotoSansSC';
import { Audio } from '@remotion/media';
import type { CSSProperties, FC } from 'react';
import { AbsoluteFill, interpolate, Sequence, staticFile, useCurrentFrame } from 'remotion';
import { Camera, wide } from '../craft/Camera';
import { dur, ease, progress, rise } from '../craft/motion';
import { Reveal } from '../craft/Reveal';

const { fontFamily } = loadFont();

// theme: the only place values come from
const t = {
  bg: '#0E0F12',
  ink: '#ECE8E1',
  muted: 'rgba(236,232,225,0.5)',
  accent: '#F2B84B',
  bubbleYou: '#2A2D35',
  bubbleCat: '#1C1E24',
  hero: 104,
  title: 210,
  body: 56,
  label: 24,
  line: 1.3,
};

// cue frames: onsets from scripts/music-cues.py at 30 fps (l1 starts the film)
const cue = { l1: 0, l2: 28, l3: 61, carry: 138, reply: 166, hint: 239, cut: 268, sweep: 307, sign: 320, end: 390 };

const Shot1Lines: FC = () => {
  const frame = useCurrentFrame();
  const out = progress(frame, cue.carry, dur.exit, ease.exit);
  const style: CSSProperties = { fontSize: t.hero, fontWeight: 800, lineHeight: t.line, color: t.ink };
  return (
    <div
      style={{ position: 'absolute', left: 240, top: 337, opacity: 1 - out, transform: `translateY(${-40 * out}px)` }}
    >
      <Reveal lines={['你随口说的一个词，']} at={cue.l1} style={style} />
      <Reveal lines={['一周前定下的决定，']} at={cue.l2} style={style} />
    </div>
  );
};

// Line 3 is the carrier: it stays on screen and becomes the message you sent.
// column 360..1560; bubble width = 9 chars × 56 + 2 × 34 = 572
const bubble = { left: 988, top: 300, padX: 34, padY: 24 };
const Carrier: FC = () => {
  const frame = useCurrentFrame();
  const p = progress(frame, cue.carry, 27, ease.move);
  const emphasis = progress(frame, 100, dur.enter);
  const from = { x: 240, y: 337 + 2 * t.hero * t.line, size: t.hero };
  const to = { x: bubble.left + bubble.padX, y: bubble.top + bubble.padY, size: t.body };
  const x = interpolate(p, [0, 1], [from.x, to.x]);
  const y = interpolate(p, [0, 1], [from.y, to.y]);
  const size = interpolate(p, [0, 1], [from.size, to.size]);
  const weight = p < 0.5 ? 800 : 500;
  const word = interpolate(emphasis, [0, 1], [0, 1]);
  return (
    <div
      style={{
        position: 'absolute',
        left: x,
        top: y,
        fontSize: size,
        fontWeight: weight,
        lineHeight: t.line,
        color: t.ink,
        whiteSpace: 'nowrap',
      }}
    >
      <Reveal lines={['一起写过的那份']} at={cue.l3} style={{ display: 'inline-block', verticalAlign: 'top' }} />
      <span style={{ color: word > 0.5 && p < 1 ? t.accent : t.ink, display: 'inline-block', verticalAlign: 'top' }}>
        <Reveal lines={['纲领']} at={cue.l3 + 3} />
      </span>
    </div>
  );
};

const YouBubble: FC = () => {
  const frame = useCurrentFrame();
  const p = progress(frame, cue.carry + 20, dur.enter);
  return (
    <div style={{ position: 'absolute', left: bubble.left, top: bubble.top - 44, opacity: p }}>
      <div style={{ color: t.muted, fontSize: t.label, height: 44 }}>你</div>
      <div
        style={{
          background: t.bubbleYou,
          borderRadius: 24,
          padding: `${bubble.padY}px ${bubble.padX}px`,
          fontSize: t.body,
          lineHeight: t.line,
          color: 'transparent', // sizes the bubble; the carrier text sits on top
          transform: `scale(${0.94 + 0.06 * p})`,
          transformOrigin: 'right center',
        }}
      >
        一起写过的那份纲领
      </div>
    </div>
  );
};

const CatReply: FC = () => {
  const frame = useCurrentFrame();
  const p = progress(frame, cue.reply, dur.enter);
  return (
    <div style={{ position: 'absolute', left: 360, top: 470, ...rise(p) }}>
      <div style={{ color: t.muted, fontSize: t.label, marginBottom: 12 }}>Ragdoll</div>
      <div
        style={{
          background: t.bubbleCat,
          borderRadius: 24,
          padding: '24px 34px',
          border: '1px solid rgba(255,255,255,0.06)',
        }}
      >
        <Reveal
          lines={['记得，七月四号写的。', '要我把原文找出来吗？']}
          at={cue.reply + 6}
          stagger={5}
          style={{ fontSize: t.body, lineHeight: t.line, color: t.ink, fontWeight: 500 }}
        />
      </div>
    </div>
  );
};

const Hint: FC = () => {
  const frame = useCurrentFrame();
  const p = progress(frame, cue.hint, dur.enter);
  const ring = progress(frame, cue.hint + 4, 22, ease.enter);
  return (
    <div
      style={{
        position: 'absolute',
        left: 364,
        top: 790,
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        ...rise(p, 12),
      }}
    >
      <div style={{ position: 'relative', width: 14, height: 14 }}>
        <div style={{ position: 'absolute', inset: 0, borderRadius: 7, background: t.accent }} />
        <div
          style={{
            position: 'absolute',
            inset: 0,
            borderRadius: 7,
            border: `2px solid ${t.accent}`,
            transform: `scale(${1 + ring * 2.6})`,
            opacity: 0.7 * (1 - ring),
          }}
        />
      </div>
      <div style={{ color: t.accent, fontSize: 38, fontWeight: 500 }}>原文在库里 · 7/4 记忆纲领</div>
    </div>
  );
};

const Shot3: FC = () => {
  const frame = useCurrentFrame(); // local to the Sequence
  const sweep = progress(frame, cue.sweep - cue.cut, 16, ease.enter);
  const sign = progress(frame, cue.sign - cue.cut, dur.enter);
  return (
    <AbsoluteFill style={{ background: t.bg, alignItems: 'center', justifyContent: 'center' }}>
      <div
        style={{
          position: 'absolute',
          width: 1100,
          height: 700,
          borderRadius: '50%',
          background: `radial-gradient(closest-side, rgba(242,184,75,0.10), transparent)`,
        }}
      />
      <div
        style={{
          position: 'relative',
          display: 'flex',
          fontSize: t.title,
          fontWeight: 800,
          color: t.ink,
          lineHeight: 1.2,
        }}
      >
        <Reveal lines={['它们']} at={0} />
        <span style={{ position: 'relative' }}>
          <span
            style={{
              position: 'absolute',
              left: 0,
              bottom: -10,
              height: 14,
              width: `${sweep * 100}%`,
              background: t.accent,
              opacity: 0.85,
              borderRadius: 6,
            }}
          />
          <span style={{ position: 'relative' }}>
            <Reveal lines={['记得']} at={4} />
          </span>
        </span>
        <Reveal lines={['。']} at={6} />
      </div>
      <div
        style={{
          position: 'absolute',
          bottom: 150,
          color: t.muted,
          fontSize: 32,
          letterSpacing: '0.08em',
          ...rise(sign, 10),
        }}
      >
        Clowder AI
      </div>
    </AbsoluteFill>
  );
};

export const OneSentenceSample: FC = () => (
  <AbsoluteFill style={{ background: t.bg, fontFamily }}>
    <Audio
      src={staticFile('bgm/first-light-particles.wav')}
      volume={(f) =>
        interpolate(f, [0, 6, cue.end - 30, cue.end], [0, 0.8, 0.8, 0], {
          extrapolateLeft: 'clamp',
          extrapolateRight: 'clamp',
        })
      }
    />
    <Sequence durationInFrames={cue.cut} layout="none">
      <Camera
        initial={wide(1920, 1080)}
        moves={[{ start: cue.hint - 3, length: 24, to: { x: 860, y: 600, zoom: 1.14 } }]}
      >
        <Shot1Lines />
        <YouBubble />
        <Carrier />
        <CatReply />
        <Hint />
      </Camera>
    </Sequence>
    <Sequence from={cue.cut} layout="none">
      <Shot3 />
    </Sequence>
  </AbsoluteFill>
);
