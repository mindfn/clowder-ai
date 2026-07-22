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

  it('eval panel labels its counts with the judgment OWN eval window (≠ query window)', async () => {
    await renderStageDetail('eval');
    expect(container.textContent).toContain('评估窗口');
    expect(container.textContent).toContain(fmt(EVAL_WINDOW.startMs));
    expect(container.textContent).not.toContain(fmt(QUERY_WINDOW.startMs));
  });
});
