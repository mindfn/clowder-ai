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

function progressStyle(phase) {
  if (phase === 'done') {
    return { fill: palette.green, stroke: palette.green, text: palette.white };
  }
  if (phase === 'current') {
    return { fill: palette.blue, stroke: palette.blue, text: palette.white };
  }
  return { fill: palette.white, stroke: palette.line, text: palette.muted };
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

function progressDots(active, count, labels) {
  const startX = 500;
  const gap = 88;
  return labels
    .map((label, index) => {
      const x = startX + index * gap;
      const phase = timelinePhase(index, active);
      const { fill, stroke, text } = progressStyle(phase);
      const connector = timelineConnector({
        index,
        total: count,
        x,
        y: 154,
        gap,
        inset: 18,
        color: palette.green,
        phase,
        width: 4,
      });
      return `${connector}
        <circle cx="${x}" cy="154" r="18" fill="${fill}" stroke="${stroke}" stroke-width="3"/>
        <text x="${x}" y="160" text-anchor="middle" class="f tag" fill="${text}">${index + 1}</text>
        <text x="${x}" y="188" text-anchor="middle" class="f small">${label}</text>`;
    })
    .join('\n');
}

const custodyFrames = [
  {
    label: 'Offer',
    state: 'OFFERED',
    stateColor: palette.amber,
    stateSoft: palette.amberSoft,
    holder: '尚无 holder',
    actor: 'none',
    token: '—',
    attempt: '—',
    progress: 'WorkUnit W-42 进入候选池',
    note: 'Offer 是 1:N；此时还没有任何人承担排他执行责任。',
    ledger: ['work.created', 'offer.created'],
  },
  {
    label: 'Claim A',
    state: 'CLAIMED',
    stateColor: palette.blue,
    stateSoft: palette.blueSoft,
    holder: 'Holder = Agent A',
    actor: 'a',
    token: '⟨7, 3, 1⟩',
    attempt: 'Attempt #1 started',
    progress: 'A 通过 CAS 建立排他 Claim',
    note: 'Claim 是 1:1；Acquire 成功同时启动 Attempt，并产生可校验 token。',
    ledger: ['work.created', 'offer.created', 'claim.accepted', 'attempt.started'],
  },
  {
    label: 'Execute',
    state: 'ACTIVE',
    stateColor: palette.green,
    stateSoft: palette.greenSoft,
    holder: 'Holder = Agent A',
    actor: 'a',
    token: '⟨7, 3, 1⟩',
    attempt: 'Attempt #1 · heartbeat ✓',
    progress: '检查点：进度 60% · effect intent 2 个',
    note: 'Attempt 属于一次会话；Claim 跨会话存续。进度和副作用意向写入 durable checkpoint。',
    ledger: ['claim.accepted', 'attempt.started', 'heartbeat', 'checkpoint.saved'],
  },
  {
    label: 'Stalled',
    state: 'STALLED',
    stateColor: palette.red,
    stateSoft: palette.redSoft,
    holder: 'Holder = Agent A（待处置）',
    actor: 'stalled',
    token: '⟨7, 3, 1⟩',
    attempt: 'Attempt #1 · heartbeat lost',
    progress: 'lease 过期 + SLA 超时',
    note: '执行静默失联没有 failed 事件；系统靠“生命迹象缺失”发现异常。',
    ledger: ['heartbeat.missed', 'lease.expired', 'attempt.stalled'],
  },
  {
    label: 'Authorize',
    state: 'TRANSFER OFFER',
    stateColor: palette.violet,
    stateSoft: palette.violetSoft,
    holder: 'Holder = Agent A',
    actor: 'transfer',
    token: 'expected ⟨7, 3, 1⟩',
    attempt: 'TransferOffer: A → B',
    progress: '授权者签发 + 有效期 + 期望 token',
    note: '职责转移需要两件事：有权的人签发 TransferOffer，以及原子 CAS 校验当前 token。',
    ledger: ['attempt.stalled', 'transfer.offered'],
  },
  {
    label: 'Accept B',
    state: 'TRANSFERRED',
    stateColor: palette.violet,
    stateSoft: palette.violetSoft,
    holder: 'Holder = Agent B',
    actor: 'b',
    token: '新 ⟨7, 4, 2⟩',
    oldToken: '旧 ⟨7, 3, 1⟩ 已失效',
    attempt: 'Attempt #2 started',
    progress: '同一 WorkUnit W-42，职责与执行权已转移',
    note: 'Claim generation 与 Attempt generation 同时旋转；A 的迟到写入和新副作用被 fence。',
    ledger: ['transfer.accepted', 'claim.rotated', 'attempt.started'],
  },
  {
    label: 'Resume',
    state: 'ACTIVE',
    stateColor: palette.green,
    stateSoft: palette.greenSoft,
    holder: 'Holder = Agent B',
    actor: 'b',
    token: '⟨7, 4, 2⟩',
    oldToken: 'A 的 token 继续无效',
    attempt: 'Attempt #2 · heartbeat ✓',
    progress: 'B 从 checkpoint + ledger + knowledge 恢复',
    note: '职责转移后的执行不是从零开始：检查点给进度，账本给责任，知识与历史给细节。',
    ledger: ['checkpoint.loaded', 'heartbeat', 'effect.reconciled'],
  },
  {
    label: 'Complete',
    state: 'COMPLETED',
    stateColor: palette.green,
    stateSoft: palette.greenSoft,
    holder: 'Claim closed',
    actor: 'complete',
    token: '⟨7, 4, 2⟩ archived',
    attempt: 'Attempt #2 completed',
    progress: 'Outcome = commit 8f4c…',
    note: 'Outcome 以不可变坐标落账，WorkUnit 终止；后续验证会绑定这个坐标。',
    ledger: ['outcome.committed', 'work.completed'],
  },
  {
    label: 'Complete',
    state: 'COMPLETED',
    stateColor: palette.green,
    stateSoft: palette.greenSoft,
    holder: 'Claim closed',
    actor: 'complete',
    token: '⟨7, 4, 2⟩ archived',
    attempt: 'Attempt #2 completed',
    progress: 'Outcome = commit 8f4c…',
    note: 'Outcome 以不可变坐标落账，WorkUnit 终止；后续验证会绑定这个坐标。',
    ledger: ['outcome.committed', 'work.completed'],
  },
];

function actorCard(x, label, active, stalled = false) {
  const fill = stalled ? palette.redSoft : active ? palette.blueSoft : palette.white;
  const stroke = stalled ? palette.red : active ? palette.blue : palette.line;
  const badge = stalled ? '失联' : active ? '当前 holder' : '候选执行者';
  const badgeFill = stalled ? palette.red : active ? palette.blue : palette.muted;
  return `<g filter="url(#shadow)">
    <rect x="${x}" y="270" width="270" height="210" rx="26" fill="${fill}" stroke="${stroke}" stroke-width="3"/>
    <circle cx="${x + 135}" cy="333" r="34" fill="${stroke}"/>
    <text x="${x + 135}" y="344" text-anchor="middle" class="f h" fill="${palette.white}">${label.slice(-1)}</text>
    <text x="${x + 135}" y="397" text-anchor="middle" class="f h">${label}</text>
    <rect x="${x + 70}" y="422" width="130" height="32" rx="16" fill="${badgeFill}"/>
    <text x="${x + 135}" y="444" text-anchor="middle" class="f tag" fill="${palette.white}">${badge}</text>
  </g>`;
}

function custodyFrame(frame, index) {
  const aActive = frame.actor === 'a' || frame.actor === 'transfer';
  const bActive = frame.actor === 'b' || frame.actor === 'complete';
  const aStalled = frame.actor === 'stalled';
  const transferArrow =
    frame.actor === 'transfer' || frame.actor === 'b' || frame.actor === 'complete'
      ? `<path d="M430 350 C560 220 1040 220 1170 350" fill="none" stroke="${palette.violet}" stroke-width="6" stroke-dasharray="${frame.actor === 'transfer' ? '14 10' : '0'}" marker-end="url(#arrow-violet)"/>
         <rect x="665" y="206" width="270" height="42" rx="21" fill="${palette.violetSoft}" stroke="${palette.violet}"/>
         <text x="800" y="234" text-anchor="middle" class="f tag" fill="${palette.violet}">${frame.actor === 'transfer' ? '授权 TransferOffer' : '职责转移已接受'}</text>`
      : '';
  const oldToken = frame.oldToken
    ? `<rect x="625" y="454" width="350" height="38" rx="19" fill="${palette.redSoft}"/>
       <text x="800" y="480" text-anchor="middle" class="f mono" fill="${palette.red}">${frame.oldToken}</text>`
    : '';
  const chips = frame.ledger
    .map(
      (event, chipIndex) =>
        `<rect x="${130 + chipIndex * 315}" y="724" width="285" height="44" rx="16" fill="${palette.slateSoft}" stroke="${palette.line}"/>
         <text x="${272 + chipIndex * 315}" y="752" text-anchor="middle" class="mono" fill="${palette.ink}">${event}</text>`,
    )
    .join('\n');
  return baseSvg(
    '同一 WorkUnit 如何安全转移职责',
    '状态变化、职责与执行权转移、fencing 在一条时间线上',
    `<g class="f">${progressDots(index, 8, ['Offer', 'Claim', '执行', '失联', '授权', '接收', '恢复', '完成'])}</g>
    ${actorCard(110, 'Agent A', aActive, aStalled)}
    ${actorCard(1220, 'Agent B', bActive)}
    ${transferArrow}
    <g filter="url(#shadow)">
      <rect x="510" y="270" width="580" height="300" rx="28" fill="${palette.white}" stroke="${frame.stateColor}" stroke-width="4"/>
      <rect x="550" y="300" width="190" height="38" rx="19" fill="${frame.stateSoft}"/>
      <text x="645" y="326" text-anchor="middle" class="f tag" fill="${frame.stateColor}">${frame.state}</text>
      <text x="550" y="382" class="f h">WorkUnit W-42</text>
      <text x="550" y="420" class="f body">${frame.holder}</text>
      <text x="550" y="456" class="f mono" fill="${frame.stateColor}">token ${frame.token}</text>
      <text x="550" y="526" class="f body">${frame.attempt}</text>
      <text x="800" y="526" class="f body" fill="${palette.muted}">${frame.progress}</text>
      ${oldToken}
    </g>
    <rect x="130" y="612" width="1340" height="72" rx="22" fill="${frame.stateSoft}" stroke="${frame.stateColor}" stroke-width="2"/>
    <text x="800" y="656" text-anchor="middle" class="f body" fill="${palette.ink}">${frame.note}</text>
    <text x="130" y="708" class="f tag" fill="${palette.muted}">COORDINATION LEDGER · 本帧新增事件</text>
    ${chips}`,
  );
}

const messageFrames = [
  {
    message: 0,
    responsibility: 0,
    note: '消息刚创建；若它只是普通信息，责任轨道可以一直保持为空。',
  },
  {
    message: 1,
    responsibility: 1,
    note: '中央队列接受只推进到 enqueued；Offer 已存在，但仍没有 Claim。',
  },
  {
    message: 2,
    responsibility: 1,
    note: '目标 runtime 接受 envelope 才是 delivered；工作仍只是 offered。',
  },
  {
    message: 3,
    responsibility: 2,
    note: '消息进入目标 prompt 才是 seen；Claim 必须由独立 CAS 事件建立。',
  },
  {
    message: 4,
    responsibility: 3,
    note: 'processed 只表示接收者已分类或回应；WorkUnit 仍在 ACTIVE。',
  },
  {
    message: 4,
    responsibility: 4,
    note: '只有 Outcome / complete 事件才能关闭工作责任；消息 ACK 不会自动完成工作。',
  },
  {
    message: 4,
    responsibility: 4,
    note: '只有 Outcome / complete 事件才能关闭工作责任；消息 ACK 不会自动完成工作。',
  },
];

function stateTrack(y, title, labels, active, color, soft) {
  const startX = 245;
  const gap = 270;
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
  const responsibilityLabels = ['obligation', 'Offer', 'Claim', 'Attempt', 'Outcome'];
  return baseSvg(
    '消息 ACK 与工作责任是两条状态机',
    '接收证据回答“消息走到哪”；责任事件回答“谁该做、是否完成”',
    `<g class="f">
      <rect x="68" y="158" width="1464" height="238" rx="28" fill="${palette.white}" stroke="${palette.blueSoft}" stroke-width="3" filter="url(#shadow)"/>
      ${stateTrack(288, '消息投递 / 消费', messageLabels, frame.message, palette.blue, palette.blueSoft)}
      <rect x="68" y="448" width="1464" height="238" rx="28" fill="${palette.white}" stroke="${palette.greenSoft}" stroke-width="3" filter="url(#shadow)"/>
      ${stateTrack(578, '工作责任 / 履行', responsibilityLabels, frame.responsibility, palette.green, palette.greenSoft)}
      <path d="M800 398 L800 444" stroke="${palette.red}" stroke-width="4" stroke-dasharray="8 8"/>
      <rect x="594" y="392" width="412" height="52" rx="22" fill="${palette.redSoft}"/>
      <text x="800" y="425" text-anchor="middle" class="f tag" fill="${palette.red}">没有自动映射：ACK ≠ Claim ≠ fulfilled</text>
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

buildAnimation('animation-custody-transfer', custodyFrames, custodyFrame);
buildAnimation('animation-message-vs-responsibility', messageFrames, messageFrame);
