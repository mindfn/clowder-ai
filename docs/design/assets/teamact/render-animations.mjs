#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const assetDir = dirname(fileURLToPath(import.meta.url));
const chrome = process.env.TEAMACT_CHROME_BIN ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const palette = {
  ink: '#172033',
  muted: '#64748B',
  line: '#CBD5E1',
  blue: '#2563EB',
  blueSoft: '#DBEAFE',
  green: '#059669',
  greenSoft: '#D1FAE5',
  amber: '#D97706',
  amberSoft: '#FEF3C7',
  red: '#DC2626',
  redSoft: '#FEE2E2',
  violet: '#7C3AED',
  violetSoft: '#EDE9FE',
  slateSoft: '#F1F5F9',
  white: '#FFFFFF',
};

function shell(command, args, options = {}) {
  execFileSync(command, args, { stdio: 'inherit', ...options });
}

function baseSvg(title, subtitle, content) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900" viewBox="0 0 1600 900" role="img">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop stop-color="#F8FBFF"/>
      <stop offset="1" stop-color="#F6F3FF"/>
    </linearGradient>
    <filter id="shadow" x="-30%" y="-30%" width="160%" height="160%">
      <feDropShadow dx="0" dy="7" stdDeviation="10" flood-color="#1E293B" flood-opacity=".11"/>
    </filter>
    <marker id="arrow-blue" markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto">
      <path d="M0,0 L10,5 L0,10 Z" fill="${palette.blue}"/>
    </marker>
    <marker id="arrow-violet" markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto">
      <path d="M0,0 L10,5 L0,10 Z" fill="${palette.violet}"/>
    </marker>
    <style>
      .f{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Noto Sans CJK SC","Segoe UI",sans-serif}
      .title{font-size:42px;font-weight:760;fill:${palette.ink}}
      .subtitle{font-size:20px;fill:${palette.muted}}
      .h{font-size:24px;font-weight:720;fill:${palette.ink}}
      .body{font-size:19px;fill:${palette.ink}}
      .small{font-size:16px;fill:${palette.muted}}
      .tag{font-size:16px;font-weight:700}
      .mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:17px}
    </style>
  </defs>
  <rect width="1600" height="900" rx="32" fill="url(#bg)"/>
  <text x="72" y="76" class="f title">${title}</text>
  <text x="72" y="112" class="f subtitle">${subtitle}</text>
  ${content}
</svg>`;
}

function timelinePhase(index, active) {
  if (index < active) {
    return 'done';
  }
  if (index === active) {
    return 'current';
  }
  return 'future';
}

function trackStyle(phase, color, soft) {
  if (phase === 'done') {
    return { fill: color, stroke: color, text: palette.white };
  }
  if (phase === 'current') {
    return { fill: soft, stroke: color, text: color };
  }
  return { fill: palette.white, stroke: palette.line, text: palette.muted };
}

function timelineConnector({ index, total, x, y, gap, inset, color, phase, width }) {
  if (index >= total - 1) {
    return '';
  }
  const stroke = phase === 'done' ? color : palette.line;
  return `<line x1="${x + inset}" y1="${y}" x2="${x + gap - inset}" y2="${y}" stroke="${stroke}" stroke-width="${width}"/>`;
}

const messageFrames = [
  {
    message: 0,
    responsibility: 0,
    note: '消息刚创建；ResponsibilityAssignment 仍是 unassigned，两条状态没有自动映射。',
  },
  {
    message: 1,
    responsibility: 1,
    note: '中央队列接受只推进到 enqueued；独立账本事务创建 offer，但尚无人承担推进义务。',
  },
  {
    message: 2,
    responsibility: 1,
    note: '目标 runtime 接受 envelope 才是 delivered；工作仍只是 offered。',
  },
  {
    message: 3,
    responsibility: 2,
    note: '消息进入目标 prompt 才是 seen；assigned(v) 必须由独立 accept 账本事务建立。',
  },
  {
    message: 4,
    responsibility: 2,
    note: 'processed 只表示接收者已分类或回应；Assignment 仍是 assigned(v)，Run 可独立更替。',
  },
  {
    message: 4,
    responsibility: 3,
    note: '只有独立验证通过后的 resolve 事务才能关闭责任；消息 ACK 不会自动完成工作。',
  },
  {
    message: 4,
    responsibility: 3,
    note: '只有独立验证通过后的 resolve 事务才能关闭责任；消息 ACK 不会自动完成工作。',
  },
];

function stateTrack(y, title, labels, active, color, soft) {
  const startX = 245;
  const gap = 1080 / (labels.length - 1);
  const nodes = labels
    .map((label, index) => {
      const x = startX + index * gap;
      const phase = timelinePhase(index, active);
      const { fill, stroke, text } = trackStyle(phase, color, soft);
      const connector = timelineConnector({
        index,
        total: labels.length,
        x,
        y,
        gap,
        inset: 62,
        color,
        phase,
        width: 8,
      });
      return `${connector}
        <rect x="${x - 78}" y="${y - 32}" width="156" height="64" rx="24" fill="${fill}" stroke="${stroke}" stroke-width="3"/>
        <text x="${x}" y="${y + 7}" text-anchor="middle" class="f tag" fill="${text}">${label}</text>`;
    })
    .join('\n');
  return `<text x="94" y="${y - 52}" class="f h">${title}</text>${nodes}`;
}

function messageFrame(frame) {
  const messageLabels = ['created', 'enqueued', 'delivered', 'seen', 'processed'];
  const responsibilityLabels = ['unassigned', 'offered', 'assigned(v)', 'resolved'];
  return baseSvg(
    '消息 ACK 与责任指派是两条状态机',
    '接收证据回答“消息走到哪”；账本事务回答“谁有推进义务、责任是否关闭”',
    `<g class="f">
      <rect x="68" y="158" width="1464" height="238" rx="28" fill="${palette.white}" stroke="${palette.blueSoft}" stroke-width="3" filter="url(#shadow)"/>
      ${stateTrack(288, '消息投递 / 消费', messageLabels, frame.message, palette.blue, palette.blueSoft)}
      <rect x="68" y="448" width="1464" height="238" rx="28" fill="${palette.white}" stroke="${palette.greenSoft}" stroke-width="3" filter="url(#shadow)"/>
      ${stateTrack(578, 'ResponsibilityAssignment', responsibilityLabels, frame.responsibility, palette.green, palette.greenSoft)}
      <path d="M800 398 L800 444" stroke="${palette.red}" stroke-width="4" stroke-dasharray="8 8"/>
      <rect x="594" y="392" width="412" height="52" rx="22" fill="${palette.redSoft}"/>
      <text x="800" y="425" text-anchor="middle" class="f tag" fill="${palette.red}">没有自动映射：ACK ≠ Assignment 事务 ≠ resolved</text>
      <rect x="140" y="736" width="1320" height="82" rx="24" fill="${palette.violetSoft}" stroke="${palette.violet}" stroke-width="2"/>
      <text x="800" y="786" text-anchor="middle" class="f body">${frame.note}</text>
    </g>`,
  );
}

function buildAnimation(name, frames, renderer) {
  const temp = mkdtempSync(join(tmpdir(), `teamact-${name}-`));
  try {
    frames.forEach((frame, index) => {
      const svgPath = join(temp, `frame-${String(index + 1).padStart(2, '0')}.svg`);
      writeFileSync(svgPath, renderer(frame, index), 'utf8');
      shell(chrome, [
        '--headless=new',
        '--hide-scrollbars',
        '--disable-gpu',
        '--force-device-scale-factor=1',
        '--window-size=1600,900',
        `--screenshot=${svgPath}.png`,
        pathToFileURL(svgPath).href,
      ]);
    });

    const output = join(assetDir, `${name}.gif`);
    shell('ffmpeg', [
      '-y',
      '-framerate',
      '2/3',
      '-start_number',
      '1',
      '-i',
      join(temp, 'frame-%02d.svg.png'),
      '-filter_complex',
      '[0:v]fps=10,scale=1200:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3',
      '-loop',
      '0',
      output,
    ]);

    const optimized = join(temp, `${name}.optimized.gif`);
    shell('gifsicle', ['-O3', '--careful', output, '-o', optimized]);
    renameSync(optimized, output);
    console.log(`Generated ${output}`);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

// The v2 custody animation is retained as historical source only; the article now reuses
// figure-v3-2-handoff-transaction.svg so the normative handoff has one visual truth source.
buildAnimation('animation-transport-vs-responsibility', messageFrames, messageFrame);
