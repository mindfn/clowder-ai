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

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EvalStagePanel } from '../components/settings/EvalStagePanel';
import { LifelineChainView } from '../components/settings/LifelineChainView';
import { LifelineStageDetail } from '../components/settings/LifelineStageDetail';

// ── Fixtures ──────────────────────────────────────────────────

/** The judgment's OWN historical eval window (e.g. a 1d window 10 days ago). */
const EVAL_WINDOW = { startMs: 1_649_999_999_000, endMs: 1_650_086_399_000 };
/** The CURRENT lifeline query window (≈ last 7d — a different coordinate). */
const QUERY_WINDOW = { startMs: 1_750_000_000_000, endMs: 1_750_604_800_000 };

function makeEval(overrides: Record<string, unknown> = {}) {
  return {
    verdict: 'alive',
    injectionCount: 0,
    violationCount: 0,
    evaluatedAt: EVAL_WINDOW.endMs,
    evalWindow: EVAL_WINDOW,
    denominatorKind: 'fired-count',
    ...overrides,
  };
}

function makeEpoch(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    origin: 'manifest',
    startedAt: 0,
    status: 'eval-pass',
    isActive: true,
    tracing: { observationCount: 18, firstAt: QUERY_WINDOW.startMs + 1000, lastAt: QUERY_WINDOW.endMs - 1000 },
    eval: makeEval(),
    governance: { decision: 'pending', decidedAt: null, actorId: null },
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

  it('shows the denominator kind of the counts (fired-count)', async () => {
    await render(createElement(EvalStagePanel, { version: 1, eval: makeEval(), tracing: null, guardMetrics: [] }));
    expect(container.textContent).toContain('fired-count');
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
    delete (legacy as Record<string, unknown>).evalWindow;
    delete (legacy as Record<string, unknown>).denominatorKind;
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
        activeStage: 'governance',
        actionable: { stage: null, candidateCount: null, source: 'unavailable' },
        queryWindow: QUERY_WINDOW,
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

// ── 判据② P1-1 (sol R1): composed viewport — 18 vs 0 on two coordinates at once ──

describe('判据② P1-1 composed render — chain + eval detail in ONE viewport', () => {
  it('shows tracing(18)+query window AND eval 0+eval window+denominator in the same DOM', async () => {
    await render(
      createElement(
        'div',
        null,
        createElement(LifelineChainView, {
          chain: [makeEpoch()],
          selected: { version: 1, stage: 'eval' },
          onSelect: () => {},
          activeStage: 'governance',
          actionable: { stage: null, candidateCount: null, source: 'unavailable' },
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
          activeStage: 'governance',
          actionable: { stage: null, candidateCount: null, source: 'unavailable' },
          queryWindow: QUERY_WINDOW,
        }),
      ),
    );
    const text = container.textContent ?? '';
    // Chain: current tracing count visible
    expect(text).toContain('tracing(18)');
    // Eval detail: historical eval count + its OWN coordinates
    expect(text).toContain('评估窗口');
    expect(text).toContain(fmt(EVAL_WINDOW.startMs));
    expect(text).toContain(fmt(EVAL_WINDOW.endMs));
    expect(text).toContain('fired-count');
    // Same viewport: the 18's coordinate (CURRENT query window) must ALSO be visible,
    // explicitly labeled as a different coordinate from the eval window.
    expect(text).toContain('当前查询窗口');
    expect(text).toContain(fmt(QUERY_WINDOW.startMs));
    expect(text).toContain(fmt(QUERY_WINDOW.endMs));
  });
});
