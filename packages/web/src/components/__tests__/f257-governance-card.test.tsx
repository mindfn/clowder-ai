import type { ApprovalHubItem } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { anchoredApprovalNavigation } from '@/test-support/approval-navigation';
import { GenericApprovalRecommendation } from '../GenericApprovalRecommendation';
import { HarnessGovernanceDecisionActions } from '../HarnessGovernanceDecisionActions';

const ITEM: ApprovalHubItem = {
  proposalId: 'HGP-1',
  sourceFeatureId: 'F257',
  requesterCatId: 'system',
  ownerUserId: 'owner-1',
  resolution: 'open',
  materialization: { state: 'not_started' },
  summary: 'Harness 治理：演进 D1',
  navigation: anchoredApprovalNavigation('thread_eval_f257_obj'),
  inlineApprovable: true,
  decisionMode: 'approve-skip-reject',
  createdAt: 1,
  detail: {
    header: {
      objective: { id: 'obj', label: '规则正确性', statement: 'Keep the behavior sound.' },
      objectiveId: 'obj',
      currentVersion: 'v1',
      decision: 'evolve',
      windows: [{ start: 0, end: 1 }],
      triggeredBy: ['cumulative', 'counterexamples'],
      triggerCounts: {
        cumulative: { count: 203, threshold: 200 },
        counterexamples: { count: 4, threshold: 3 },
      },
    },
    conclusions: [
      {
        id: 'metric-a',
        conclusion: { kind: 'count', value: 3, howCounted: '逐条核对本周期反例后，共确认 3 次。' },
      },
    ],
    coverageAssessment: {
      status: 'gaps_found',
      rationale: '检测规则漏掉一个自标事件。',
      findings: [
        {
          kind: 'detector_gap',
          basis: 'mcp-marker',
          metricId: 'metric-a',
          rationale: '当前结构化规则没有覆盖 invocation-1。',
          evidenceRefs: ['invocation-1'],
        },
      ],
    },
    metricVisuals: [{ id: 'metric-a', currentValue: 3, previousValue: 5, delta: -2, lowerIsBetter: true }],
    hasComparisonBaseline: true,
    governanceReason: '反例显示内容需要收紧。',
    history: [{ cycleId: 'old-cycle', approval: { state: 'skipped' } }],
    rejectReasons: ['上一版没有解释边界。'],
    changes: [
      {
        unitId: 'D1',
        action: 'modify',
        reason: '去掉歧义',
        beforeContent: 'old content',
        proposedContent: 'new content',
      },
    ],
    evidenceRefs: ['invocation-1'],
    cardOrdinal: 2,
  },
};

describe('F257 governance card', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as Record<string, unknown>).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterAll(() => {
    delete (globalThis as Record<string, unknown>).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('combines metric values and changes, humanizes conclusions, and opens action diffs in a dialog', async () => {
    await act(async () => {
      root.render(
        <GenericApprovalRecommendation
          item={ITEM}
          f193TargetThreadId=""
          sourceThreadTitle="Harness Objective"
          targetThreadTitle={null}
          resolveCatName={(catId) => catId}
        />,
      );
    });

    for (const section of ['header', 'metrics', 'conclusions', 'changes', 'lineage']) {
      expect(container.querySelector(`[data-testid="f257-governance-${section}"]`)).not.toBeNull();
    }
    expect(container.querySelector('[data-testid="f257-governance-deltas"]')).not.toBeNull();
    const text = container.textContent ?? '';
    expect(text).not.toContain('old content');
    expect(text).not.toContain('new content');
    expect(text).toContain('规则正确性');
    expect(text).toContain('203/200');
    expect(text).toContain('cumulative / counterexamples');
    expect(text).toContain('上一版没有解释边界。');
    expect(text).toContain('检测器缺口 · metric-a');
    expect(text).toContain('当前结构化规则没有覆盖 invocation-1。');
    expect(text).toContain('invocation-1');
    expect(container.querySelector('[data-testid="f257-governance-evidence-link"]')).not.toBeNull();
    expect(text).toContain('拒绝必须填写理由');
    expect(text).toContain('上周期');
    expect(text).toContain('本周期');
    expect(text).toContain('-2');
    expect(container.querySelector('[data-testid="f257-governance-metric-bar-previous"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="f257-governance-metric-bar-current"]')).not.toBeNull();
    expect(text).toContain('3 次');
    expect(text).toContain('逐条核对本周期反例后，共确认 3 次。');
    expect(text).not.toContain('{"kind"');
    expect(text).toContain('不可挑批');

    const diffButton = container.querySelector<HTMLButtonElement>('[data-testid="f257-governance-open-diff"]');
    expect(diffButton?.textContent).toContain('查看左右差异');
    await act(async () => diffButton?.click());
    const dialog = document.body.querySelector('[data-testid="f257-governance-diff-dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain('应用前');
    expect(dialog?.textContent).toContain('应用后');
    expect(dialog?.textContent).toContain('old content');
    expect(dialog?.textContent).toContain('new content');
    expect(dialog?.querySelector('button[aria-pressed="true"]')?.textContent).toContain('Side-by-side');
  });

  it('states that a first-cycle proposal has no comparison baseline', async () => {
    const firstCycle = {
      ...ITEM,
      detail: {
        ...ITEM.detail,
        history: [],
        metricVisuals: [{ id: 'metric-a', currentValue: 3, previousValue: null, delta: null, lowerIsBetter: true }],
        hasComparisonBaseline: false,
        isFirstCycle: true,
      },
    };
    await act(async () => {
      root.render(
        <GenericApprovalRecommendation
          item={firstCycle}
          f193TargetThreadId=""
          sourceThreadTitle="Harness Objective"
          targetThreadTitle={null}
          resolveCatName={(catId) => catId}
        />,
      );
    });
    expect(container.textContent).toContain('首轮评估，暂无可比较的历史基线');
    expect(container.querySelector('[data-testid="f257-governance-first-cycle"]')).not.toBeNull();
  });

  it('shows disable impact in the action list and compares the full before state in the dialog', async () => {
    const disableItem: ApprovalHubItem = {
      ...ITEM,
      detail: {
        ...ITEM.detail,
        changes: [
          {
            unitId: 'D2',
            action: 'disable',
            reason: '消融验证该段是否仍有必要。',
            beforeEnabled: true,
            beforeContent: 'current hook content',
            objectiveImpact: { objectiveId: 'obj', remainingMemberCount: 2 },
          },
        ],
      },
    };
    await act(async () => {
      root.render(
        <GenericApprovalRecommendation
          item={disableItem}
          f193TargetThreadId=""
          sourceThreadTitle="Harness Objective"
          targetThreadTitle={null}
          resolveCatName={(catId) => catId}
        />,
      );
    });

    expect(container.textContent).toContain('动作后剩余成员段 2 个');
    expect(container.textContent).not.toContain('current hook content');
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="f257-governance-open-diff"]')?.click(),
    );
    const dialog = document.body.querySelector('[data-testid="f257-governance-diff-dialog"]');
    expect(dialog?.textContent).toContain('current hook content');
    expect(dialog?.textContent).toContain('此段将不再注入');
  });

  it('offers approve/skip/reject and keeps reject disabled until a reason exists', async () => {
    const decide = vi.fn();
    await act(async () => {
      root.render(<HarnessGovernanceDecisionActions onDecide={decide} />);
    });
    const reject = container.querySelector<HTMLButtonElement>('[data-testid="reject-btn"]');
    expect(reject?.disabled).toBe(true);
    expect(reject?.className).toContain('disabled:bg-semantic-critical-surface');
    expect(reject?.className).toContain('disabled:text-semantic-critical/60');
    expect(reject?.className).not.toContain('disabled:opacity-50');
    expect(container.querySelector('[data-testid="skip-btn"]')).not.toBeNull();

    const note = container.querySelector<HTMLTextAreaElement>('[data-testid="f257-governance-note"]');
    await act(async () => {
      if (!note) throw new Error('missing note');
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      setter?.call(note, '评估漏掉了关键反例');
      note.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(reject?.disabled).toBe(false);
    await act(async () => reject?.click());
    expect(decide).toHaveBeenCalledWith('reject', '评估漏掉了关键反例');
  });
});
