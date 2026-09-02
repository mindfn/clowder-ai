import type { ApprovalItem } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { anchoredApprovalNavigation } from '@/test-support/approval-navigation';
import { GenericApprovalRecommendation } from '../GenericApprovalRecommendation';
import { HarnessGovernanceDecisionActions } from '../HarnessGovernanceDecisionActions';

const ITEM: ApprovalItem = {
  proposalId: 'HGP-1',
  sourceFeatureId: 'F257',
  requesterCatId: 'system',
  ownerUserId: 'owner-1',
  status: 'pending',
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
    conclusions: [{ id: 'metric-a', conclusion: { kind: 'count', value: 3 } }],
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

  it('renders all five sections and the complete before/after content', async () => {
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

    for (const section of ['header', 'conclusions', 'changes', 'evidence', 'lineage']) {
      expect(container.querySelector(`[data-testid="f257-governance-${section}"]`)).not.toBeNull();
    }
    const text = container.textContent ?? '';
    expect(text).toContain('old content');
    expect(text).toContain('new content');
    expect(text).toContain('规则正确性');
    expect(text).toContain('203/200');
    expect(text).toContain('cumulative / counterexamples');
    expect(text).toContain('上一版没有解释边界。');
    expect(text).toContain('invocation-1');
    expect(container.querySelector('[data-testid="f257-governance-evidence-link"]')).not.toBeNull();
    expect(text).toContain('拒绝必须填写理由');
  });

  it('offers approve/skip/reject and keeps reject disabled until a reason exists', async () => {
    const decide = vi.fn();
    await act(async () => {
      root.render(<HarnessGovernanceDecisionActions onDecide={decide} />);
    });
    const reject = container.querySelector<HTMLButtonElement>('[data-testid="reject-btn"]');
    expect(reject?.disabled).toBe(true);
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
