/**
 * F257 #6 slice 6c — 判据② eval window / denominator provenance UI tests
 * (jsdom real render, not source-regex).
 *
 * Original incident (V2 thread, operator screenshot): lifeline showed
 * tracing(18) vs eval injectionCount=0 as if contradictory — but 18 came
 * from the CURRENT 7d query window while 0 came from the judgment's OWN
 * historical eval window. The two coordinates were never labeled.
 *
 * Contract:
 *   - eval panel shows the judgment's OWN eval window [startMs,endMs) +
 *     denominatorKind, never the lifeline query window;
 *   - tracing panel labels the CURRENT query window as such;
 *   - legacy cached judgment without window/denominator → fail-visible
 *     "评估窗口未知 / 分母未知", never guessed from evaluatedAt.
 */

import type { EvalStageSummary, VersionEpoch } from '@cat-cafe/shared';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EvalStagePanel } from '../components/settings/EvalStagePanel';
import { LifelineChainView } from '../components/settings/LifelineChainView';
import { LifelineStageDetail } from '../components/settings/LifelineStageDetail';
import { observationsForObjectiveCycle } from '../components/settings/SegmentLifelineModal';
import { SegmentTraceTheater } from '../components/settings/SegmentTraceTheater';

// ── Fixtures ──────────────────────────────────────────────────

/** The judgment's OWN historical eval window (e.g. a 1d window 10 days ago). */
const EVAL_WINDOW = { startMs: 1_649_999_999_000, endMs: 1_650_086_399_000 };
/** The CURRENT lifeline query window (≈ last 7d — a different coordinate). */
const QUERY_WINDOW = { startMs: 1_750_000_000_000, endMs: 1_750_604_800_000 };

function makeEval(overrides: Partial<EvalStageSummary> = {}): EvalStageSummary {
  // Producer-reachable state ONLY (sol R2 P1-2): segment-judgment-engine
  // produceVerdict — injectionCount=0 → 'unmeasurable' + denominatorKind 'none'.
  // ('alive' + 0 + 'fired-count' is impossible under the authoritative producer.)
  return {
    verdict: 'unmeasurable',
    injectionCount: 0,
    violationCount: 0,
    evaluatedAt: EVAL_WINDOW.endMs,
    evalWindow: EVAL_WINDOW,
    evalWindowGap: null,
    denominatorKind: 'none',
    denominatorGap: null,
    ...overrides,
  };
}

function makeEnablementMatrix(): import('@cat-cafe/shared').SegmentEnablementMatrix {
  return {
    segmentId: 'S-x',
    safetyTier: 'editable',
    allowLocalOverride: true,
    disableable: true,
    localOverlay: {
      hasOverlay: false,
      hasBackup: false,
      actions: {
        edit: { allowed: true, reason: null, reasonCode: null },
        restoreBackup: { allowed: false, reason: '当前段无备份文件', reasonCode: 'no-backup' },
        reset: { allowed: false, reason: '当前段无本地覆盖可重置', reasonCode: 'no-local-overlay' },
      },
    },
    runtimeOverride: {
      enabled: true,
      hasOverride: false,
      hasContentOverride: false,
      hasVersionSnapshot: false,
      availableEpochVersions: [],
      actions: {
        disable: { allowed: true, reason: null, reasonCode: null },
        enable: { allowed: false, reason: '当前段已启用', reasonCode: 'already-enabled' },
        rollback: { allowed: false, reason: '当前段无覆盖可回滚', reasonCode: 'no-override' },
        activateVersion: { allowed: false, reason: '当前段无保留版本可激活', reasonCode: 'no-version-snapshot' },
      },
    },
  };
}

function makeEpoch(overrides: Partial<VersionEpoch> = {}): VersionEpoch {
  return {
    version: 1,
    parentVersion: null,
    origin: 'manifest',
    startedAt: 0,
    // unmeasurable → cycle returns to tracing (6b loop model): eval-pending, no governance.
    status: 'eval-pending',
    isActive: true,
    tracing: {
      observationCount: 18,
      firedCount: 18,
      disabledCount: 0,
      firstAt: QUERY_WINDOW.startMs + 1000,
      lastAt: QUERY_WINDOW.endMs - 1000,
    },
    eval: makeEval(),
    governance: null,
    events: [],
    ...overrides,
  };
}

// ── Render harness ────────────────────────────────────────────

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.removeChild(container);
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

async function render(element: React.ReactElement) {
  await act(async () => {
    root.render(element);
  });
}

const fmt = (ms: number) => new Date(ms).toLocaleString();

// ── 判据② EvalStagePanel — eval window provenance ─────────────

describe('判据② EvalStagePanel — the judgment OWN eval window', () => {
  it('shows the eval window range labeled as 评估窗口 (sampling interval), not the query window', async () => {
    await render(createElement(EvalStagePanel, { version: 1, eval: makeEval(), tracing: null, guardMetrics: [] }));
    expect(container.textContent).toContain('评估窗口');
    expect(container.textContent).toContain(fmt(EVAL_WINDOW.startMs));
    expect(container.textContent).toContain(fmt(EVAL_WINDOW.endMs));
    // The query window must NOT be presented as the eval window.
    expect(container.textContent).not.toContain(fmt(QUERY_WINDOW.startMs));
  });

  it('shows the denominator kind of the counts (none — unmeasurable has no denominator)', async () => {
    await render(createElement(EvalStagePanel, { version: 1, eval: makeEval(), tracing: null, guardMetrics: [] }));
    expect(container.textContent).toContain('无分母（不可计算比率）');
  });

  it('legacy eval (null window/denominator) → fail-visible 未知, never guessed from evaluatedAt', async () => {
    await render(
      createElement(EvalStagePanel, {
        version: 1,
        eval: makeEval({ evalWindow: null, denominatorKind: null }),
        tracing: null,
        guardMetrics: [],
      }),
    );
    expect(container.textContent).toContain('评估窗口未知');
    expect(container.textContent).toContain('分母未知');
    // Must NOT silently present evaluatedAt as the window start/end pair.
    expect(container.textContent).not.toContain(`${fmt(EVAL_WINDOW.startMs)}`);
  });

  it('undefined fields (older API response) degrade to the same fail-visible unknown', async () => {
    const legacy = makeEval();
    delete (legacy as unknown as Record<string, unknown>).evalWindow;
    delete (legacy as unknown as Record<string, unknown>).denominatorKind;
    await render(createElement(EvalStagePanel, { version: 1, eval: legacy, tracing: null, guardMetrics: [] }));
    expect(container.textContent).toContain('评估窗口未知');
    expect(container.textContent).toContain('分母未知');
  });
});

// ── 判据② 18-vs-0: two coordinates visibly distinct ──────────

describe('判据② tracing vs eval — the 18-vs-0 incident guard', () => {
  function renderStageDetail(stage: 'tracing' | 'eval') {
    return render(
      createElement(LifelineStageDetail, {
        selected: { version: 1, stage },
        chain: [makeEpoch()],
        observations: [],
        guardEvents: [],
        epochGuardMetrics: { 1: [] },
        overrideState: null,
        hookId: 'S-x',
        onRefresh: () => {},
        activeStage: 'tracing',
        actionable: { stage: null, candidateCount: null, source: 'unavailable' },
        queryWindow: QUERY_WINDOW,
        enablementMatrix: makeEnablementMatrix(),
      }),
    );
  }

  it('tracing panel labels its counts with the CURRENT query window', async () => {
    await renderStageDetail('tracing');
    expect(container.textContent).toContain('18');
    expect(container.textContent).toContain('查询窗口');
    expect(container.textContent).toContain(fmt(QUERY_WINDOW.startMs));
  });

  it('eval panel labels its counts with the judgment OWN eval window; query window appears only as labeled contrast (P1-1)', async () => {
    await renderStageDetail('eval');
    expect(container.textContent).toContain('评估窗口');
    expect(container.textContent).toContain(fmt(EVAL_WINDOW.startMs));
    // P1-1: the query window MAY appear in the eval viewport — but only inside the
    // coordinate-contrast block, explicitly labeled 当前查询窗口 (never as 评估窗口).
    expect(container.textContent).toContain('当前查询窗口');
    expect(container.textContent).toContain(fmt(QUERY_WINDOW.startMs));
    // The eval-window row itself must carry the eval coordinate: 评估窗口 label
    // precedes the eval range, and the query range never follows the 评估窗口 label.
    const text = container.textContent ?? '';
    const evalLabelIdx = text.indexOf('评估窗口');
    expect(evalLabelIdx).toBeGreaterThanOrEqual(0);
    expect(text.indexOf(fmt(EVAL_WINDOW.startMs), evalLabelIdx)).toBeGreaterThan(evalLabelIdx);
    const queryIdxAfterEvalLabel = text.indexOf(fmt(QUERY_WINDOW.startMs), evalLabelIdx);
    const evalEndIdx = text.indexOf(fmt(EVAL_WINDOW.endMs), evalLabelIdx);
    expect(queryIdxAfterEvalLabel === -1 || queryIdxAfterEvalLabel > evalEndIdx).toBe(true);
  });
});

describe('F257 segment activity presentation', () => {
  function readiness(
    overrides: Partial<import('@cat-cafe/shared').SegmentTracingEvaluationView['trigger']['objective']> = {},
  ): import('@cat-cafe/shared').SegmentTracingEvaluationView {
    return {
      trigger: {
        objective: {
          objectiveId: 'iron-law-compliance',
          lifecycle: 'active',
          health: 'healthy',
          policyChangeCount: 0,
          evalStatus: 'idle',
          cycleStartMs: QUERY_WINDOW.startMs,
          cycleEndMs: null,
          triggeredBy: [],
          cumulative: { count: 251, threshold: 200 },
          counterexamples: { count: 0, threshold: 3 },
          cadence: { elapsedMs: 1000, thresholdMs: 7 * 24 * 60 * 60 * 1000, eligible: true },
          ...overrides,
        },
        segment: {
          segmentId: 'L4',
          observationCount: 251,
          injectionCount: 101,
          disabledCount: 150,
        },
      },
      injections: [],
      injectionsCapped: false,
      structuredCounterexamples: [],
    };
  }

  it('keeps default state quiet and shows cycle-aligned segment injection over Objective Tracing', async () => {
    await render(
      createElement(SegmentTraceTheater, {
        segmentId: 'L4',
        observations: [],
        window: QUERY_WINDOW,
        readiness: readiness(),
      }),
    );
    const text = container.textContent ?? '';
    expect(text).toContain('周期累计Tracing251/200 条');
    expect(text).toContain('周期内注入Tracing101/251');
    expect(text).toContain('周期内反例Tracing');
    expect(text).toContain('禁用 150 次');
    expect(text).not.toContain('点击记录查看完整现场');
    expect(text).not.toContain('本段查询窗');
    expect(text).not.toContain('本段注入明细');
    expect(text).not.toContain('触发策略已调整 0 次');
    expect(text).not.toMatch(/\bidle\b/);
    expect(text).not.toMatch(/\bactive\b/);
  });

  it('keeps the expanded injection rows inside the same end-exclusive Objective cycle window', () => {
    const cycleEndMs = QUERY_WINDOW.startMs + 100;
    const trigger = readiness({ cycleEndMs }).trigger.objective;
    const observations = [trigger.cycleStartMs - 1, trigger.cycleStartMs, cycleEndMs - 1, cycleEndMs].map(
      (timestamp, index) => ({
        threadId: `thread-${index}`,
        turnId: `turn-${index}`,
        timestamp,
        catId: 'sol',
        pipelineStatus: 'fired',
        version: 1,
        charCount: 10,
      }),
    );

    expect(
      observationsForObjectiveCycle(observations, trigger, QUERY_WINDOW.endMs).map((row) => row.timestamp),
    ).toEqual([trigger.cycleStartMs, cycleEndMs - 1]);
  });

  it('shows only non-default states and localizes them', async () => {
    await render(
      createElement(SegmentTraceTheater, {
        segmentId: 'L4',
        observations: [],
        window: QUERY_WINDOW,
        readiness: readiness({ evalStatus: 'stalled', lifecycle: 'dormant', policyChangeCount: 2 }),
      }),
    );
    const text = container.textContent ?? '';
    expect(text).toContain('评估停滞');
    expect(text).toContain('已休眠');
    expect(text).toContain('触发策略已调整 2 次');
    expect(text).not.toMatch(/\bstalled\b/);
    expect(text).not.toMatch(/\bdormant\b/);
  });
});

// ── 判据② P1-1 (sol R1): composed viewport — 18 vs 0 on two coordinates at once ──

describe('判据② P1-1 composed render — chain + eval detail in ONE viewport', () => {
  it('keeps version line count-free while eval detail preserves its own window and denominator', async () => {
    await render(
      createElement(
        'div',
        null,
        createElement(LifelineChainView, {
          chain: [makeEpoch()],
          selected: { version: 1, stage: 'eval' },
          onSelect: () => {},
        }),
        createElement(LifelineStageDetail, {
          selected: { version: 1, stage: 'eval' },
          chain: [makeEpoch()],
          observations: [],
          guardEvents: [],
          epochGuardMetrics: { 1: [] },
          overrideState: null,
          hookId: 'S-x',
          onRefresh: () => {},
          activeStage: 'tracing',
          actionable: { stage: null, candidateCount: null, source: 'unavailable' },
          queryWindow: QUERY_WINDOW,
          enablementMatrix: makeEnablementMatrix(),
        }),
      ),
    );
    const text = container.textContent ?? '';
    // Version line is stage-only; the detail panel owns the query-window count.
    expect(text).toContain('当前注入18次');
    expect(text).not.toContain('版本生命线v1→注入');
    expect(text).not.toContain('tracing(18)');
    // Eval detail: historical eval count + its OWN coordinates
    expect(text).toContain('评估窗口');
    expect(text).toContain(fmt(EVAL_WINDOW.startMs));
    expect(text).toContain(fmt(EVAL_WINDOW.endMs));
    expect(text).toContain('无分母（不可计算比率）');
    // Producer-contract guard (sol R2 P1-2): unmeasurable = injectionCount 0,
    // and the DENOMINATOR row must not show a fired-count label for it. (The
    // contrast block legitimately names the current-side metric fired-count —
    // the guard targets the eval denominator label specifically.)
    expect(text).toContain('无分母');
    expect(text).not.toContain('fired-count（注入次数计数）');
    // Same viewport: the 18's coordinate (CURRENT query window) must ALSO be visible,
    // explicitly labeled as a different coordinate from the eval window.
    expect(text).toContain('当前查询窗口');
    expect(text).toContain(fmt(QUERY_WINDOW.startMs));
    expect(text).toContain(fmt(QUERY_WINDOW.endMs));
  });
});

describe('F257 version lifeline — version and Objective cycle are separate coordinates', () => {
  const completedCycle = {
    cycleId: 'cycle-keep-1',
    version: 'objective-v1',
    versionContentRef: 'objective:wait-wakeup-liveness@v1',
    cycleStart: QUERY_WINDOW.startMs,
    cycleEnd: QUERY_WINDOW.startMs + 10_000,
    evalStatus: 'written' as const,
    windows: [{ start: QUERY_WINDOW.startMs, end: QUERY_WINDOW.startMs + 10_000 }],
    triggeredBy: ['cumulative' as const],
    evaluation: { overall: 'complete' as const, writtenAt: QUERY_WINDOW.startMs + 9_000, by: 'evaluator' },
    governance: {
      decision: 'keep' as const,
      reason: 'stable',
      writtenAt: QUERY_WINDOW.startMs + 9_500,
      by: 'evaluator',
    },
    approval: null,
    rejectReasons: [],
    closedAt: QUERY_WINDOW.startMs + 10_000,
  };
  const currentCycle = {
    ...completedCycle,
    cycleId: 'cycle-current-2',
    cycleStart: QUERY_WINDOW.startMs + 10_000,
    cycleEnd: null,
    evalStatus: 'idle' as const,
    windows: [],
    triggeredBy: [],
    evaluation: null,
    governance: null,
    closedAt: null,
  };

  it('compresses repeated cycles into one card and expands an exact cycle chooser', async () => {
    await render(
      createElement(LifelineChainView, {
        chain: [makeEpoch()],
        cycles: [completedCycle, currentCycle],
        currentCycleId: currentCycle.cycleId,
        selected: { version: 1, stage: 'tracing', cycleId: currentCycle.cycleId },
        onSelect: () => {},
      }),
    );

    expect(container.querySelectorAll('[data-stage="tracing"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-stage="eval"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-stage="governance"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-current="true"]')).toHaveLength(1);
    expect(container.querySelector('[data-current="true"]')?.textContent).toBe('tracing');
    expect(container.querySelectorAll('[data-cycle-group]')).toHaveLength(1);
    expect(container.querySelector('[data-cycle-switcher]')?.textContent).toContain('第 2 周期');
    expect(container.querySelector('[data-cycle-switcher]')?.textContent).toContain('选择');
    expect(container.querySelector('[data-cycle-switcher]')?.textContent).not.toContain('共 2 次');
    expect(container.querySelectorAll('button[data-cycle-id="cycle-keep-1"]')).toHaveLength(0);
    expect(container.querySelectorAll('button[data-cycle-id="cycle-current-2"]')).toHaveLength(3);

    act(() => (container.querySelector('[data-cycle-switcher]') as HTMLButtonElement).click());
    expect(container.querySelectorAll('[data-cycle-option]')).toHaveLength(2);
  });

  it('lets the operator select a historical stage and moves the visual highlight away from the live stage', async () => {
    const onSelect = vi.fn();
    await render(
      createElement(LifelineChainView, {
        chain: [makeEpoch()],
        cycles: [completedCycle, currentCycle],
        currentCycleId: currentCycle.cycleId,
        selected: { version: 1, stage: 'eval', cycleId: completedCycle.cycleId },
        onSelect,
      }),
    );

    const historicalEval = container.querySelector(
      'button[data-cycle-id="cycle-keep-1"][data-stage="eval"]',
    ) as HTMLButtonElement;
    expect(historicalEval).toBeTruthy();
    expect(historicalEval.getAttribute('aria-pressed')).toBe('true');
    expect(historicalEval.innerHTML).toContain('!bg-cafe-accent');
    expect(container.querySelector('button[data-cycle-id="cycle-current-2"]')).toBeNull();

    act(() => historicalEval.click());
    expect(onSelect).toHaveBeenCalledWith({ version: 1, stage: 'eval', cycleId: 'cycle-keep-1' });
  });

  it('keeps every inactive node gray and never puts injection counts in the version line', async () => {
    await render(
      createElement(LifelineChainView, {
        chain: [makeEpoch()],
        cycles: [completedCycle, currentCycle],
        currentCycleId: currentCycle.cycleId,
        selected: { version: 1, stage: 'tracing', cycleId: currentCycle.cycleId },
        onSelect: () => {},
      }),
    );

    expect(container.textContent).not.toContain('注入 18 次');
    for (const node of container.querySelectorAll('[data-current="false"]')) {
      expect(node.innerHTML).toContain('bg-conn-slate-bg');
      expect(node.innerHTML).not.toContain('!bg-cafe-accent');
    }
  });

  it('renders version ancestry vertically so rollback from v2 can branch v3 from v1', async () => {
    const v1 = makeEpoch({ version: 1, parentVersion: null, isActive: false });
    const v2 = makeEpoch({
      version: 2,
      parentVersion: 1,
      origin: 'auto-iterate',
      startedAt: 100,
      isActive: false,
    });
    const v3 = makeEpoch({
      version: 3,
      parentVersion: 1,
      origin: 'auto-iterate',
      startedAt: 300,
      isActive: true,
    });
    await render(
      createElement(LifelineChainView, {
        chain: [v1, v2, v3],
        selected: { version: 3, stage: 'version' },
        onSelect: () => {},
      }),
    );

    expect(container.querySelector('[data-version-tree]')).toBeTruthy();
    expect(container.querySelectorAll('[data-parent-version="1"]')).toHaveLength(2);
    expect(container.textContent).toContain('源自 v1');
  });

  it('assigns cycles by the activation timeline after an older version is reactivated', async () => {
    const v1 = makeEpoch({ version: 1, parentVersion: null, startedAt: 0, isActive: false });
    const v2 = makeEpoch({
      version: 2,
      parentVersion: 1,
      origin: 'auto-iterate',
      startedAt: 100,
      isActive: false,
    });
    const v3 = makeEpoch({
      version: 3,
      parentVersion: 1,
      origin: 'auto-iterate',
      startedAt: 350,
      isActive: true,
    });
    const cycleOnV2 = { ...completedCycle, cycleId: 'cycle-v2', cycleStart: 150, cycleEnd: 200 };
    const cycleOnReturnedV1 = {
      ...completedCycle,
      cycleId: 'cycle-v1-return',
      cycleStart: 300,
      cycleEnd: 340,
    };
    const cycleOnV3 = { ...currentCycle, cycleId: 'cycle-v3', cycleStart: 400 };

    await render(
      createElement(LifelineChainView, {
        chain: [v1, v2, v3],
        cycles: [cycleOnV2, cycleOnReturnedV1, cycleOnV3],
        versionActivations: [
          { timestamp: 0, version: 1 },
          { timestamp: 100, version: 2 },
          { timestamp: 250, version: 1 },
          { timestamp: 350, version: 3 },
        ],
        currentCycleId: cycleOnV3.cycleId,
        selected: { version: 1, stage: 'governance', cycleId: cycleOnReturnedV1.cycleId },
        onSelect: () => {},
      }),
    );

    expect(container.querySelector('[data-version-node="1"] [data-cycle-group="cycle-v1-return"]')).toBeTruthy();
    expect(container.querySelector('[data-version-node="2"] [data-cycle-group="cycle-v2"]')).toBeTruthy();
    expect(container.querySelector('[data-version-node="3"] [data-cycle-group="cycle-v3"]')).toBeTruthy();
  });
});

// ── P1 (sol R5/R6): current-side metric honesty in the contrast block ──

describe('P1 (sol R5/R6) contrast block — fired vs observed + exact-count completeness', () => {
  function renderEvalWithTracing(tracing: {
    observationCount: number;
    firedCount: number;
    disabledCount: number;
    firstAt: number | null;
    lastAt: number | null;
  }) {
    return render(
      createElement(EvalStagePanel, {
        version: 1,
        eval: makeEval(),
        tracing,
        guardMetrics: [],
        queryWindow: QUERY_WINDOW,
      }),
    );
  }

  it('observe-only rows render as 观测行数, never inflate 当前注入 (fired-count)', async () => {
    await renderEvalWithTracing({
      observationCount: 1,
      firedCount: 0,
      disabledCount: 0,
      firstAt: QUERY_WINDOW.startMs + 1000,
      lastAt: QUERY_WINDOW.endMs - 1000,
    });
    const text = container.textContent ?? '';
    expect(text).toContain('当前注入');
    expect(text).toContain('观测行数');
    expect(text).toContain('observe-only');
    // The fired metric is 0 — the single observe-only row must NOT appear as an injection.
    // (Scope to the 当前注入 row only; the 观测行数 row legitimately shows 1.)
    const firedRow = (text.split('当前注入')[1] ?? '').split('观测行数')[0] ?? '';
    expect(firedRow).toContain('0');
    expect(firedRow).not.toContain('1');
  });

  it('aggregate counts are EXACT — no lower-bound markers (sol R6: completeness lives on the detail list)', async () => {
    await renderEvalWithTracing({
      observationCount: 101,
      firedCount: 101,
      disabledCount: 0,
      firstAt: QUERY_WINDOW.startMs + 1000,
      lastAt: QUERY_WINDOW.endMs - 1000,
    });
    const text = container.textContent ?? '';
    expect(text).toContain('101');
    expect(text).not.toContain('≥');
    expect(text).not.toContain('下限');
  });

  it('detail-capped response shows the truncation note while counts stay exact (sol R6 P1)', async () => {
    await render(
      createElement(LifelineStageDetail, {
        selected: { version: 1, stage: 'tracing' },
        chain: [
          makeEpoch({
            tracing: {
              observationCount: 101,
              firedCount: 101,
              disabledCount: 0,
              firstAt: QUERY_WINDOW.startMs + 1000,
              lastAt: QUERY_WINDOW.endMs - 1000,
            },
          }),
        ],
        observations: [],
        observationsCapped: true,
        guardEvents: [],
        epochGuardMetrics: { 1: [] },
        overrideState: null,
        hookId: 'S-x',
        onRefresh: () => {},
        activeStage: 'tracing',
        actionable: { stage: null, candidateCount: null, source: 'unavailable' },
        queryWindow: QUERY_WINDOW,
        enablementMatrix: makeEnablementMatrix(),
      }),
    );
    const text = container.textContent ?? '';
    expect(text).toContain('注入 101 次');
    expect(text).toContain('明细仅显示最近 100 条');
    expect(text).toContain('精确聚合');
  });
});

// ── P2 (sol R5): gap kind — corrupted provenance must not be mislabeled legacy ──

describe('P2 (sol R5) gap kind — invalid-present vs legacy-missing', () => {
  it('invalid-present window/denominator renders 数据损坏, not 历史缓存缺字段', async () => {
    await render(
      createElement(EvalStagePanel, {
        version: 1,
        eval: makeEval({
          evalWindow: null,
          evalWindowGap: 'invalid-present',
          denominatorKind: null,
          denominatorGap: 'invalid-present',
        }),
        tracing: null,
        guardMetrics: [],
      }),
    );
    const text = container.textContent ?? '';
    expect(text).toContain('评估窗口不可用（缓存数据损坏）');
    expect(text).toContain('分母不可用（缓存数据损坏）');
    expect(text).not.toContain('历史缓存缺字段');
  });

  it('legacy-missing gap renders the legacy wording (unchanged contract)', async () => {
    await render(
      createElement(EvalStagePanel, {
        version: 1,
        eval: makeEval({
          evalWindow: null,
          evalWindowGap: 'legacy-missing',
          denominatorKind: null,
          denominatorGap: 'legacy-missing',
        }),
        tracing: null,
        guardMetrics: [],
      }),
    );
    const text = container.textContent ?? '';
    expect(text).toContain('评估窗口未知（历史缓存缺字段）');
    expect(text).toContain('分母未知（历史缓存缺字段）');
  });
});
