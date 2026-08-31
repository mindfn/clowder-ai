import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import F257GovernanceJourneyDemo from '../page';

describe('F257 governance journey experience gate', () => {
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
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function render() {
    await act(async () => root.render(<F257GovernanceJourneyDemo />));
  }

  async function click(testId: string) {
    await act(async () => {
      const target = container.querySelector(`[data-testid="${testId}"]`);
      const button = target instanceof HTMLButtonElement ? target : target?.querySelector('button');
      if (!(button instanceof HTMLButtonElement)) throw new Error(`missing button ${testId}`);
      button.click();
    });
  }

  async function type(testId: string, value: string) {
    await act(async () => {
      const target = container.querySelector(`[data-testid="${testId}"]`);
      if (!(target instanceof HTMLTextAreaElement)) throw new Error(`missing textarea ${testId}`);
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      valueSetter?.call(target, value);
      target.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  it('starts with an always-visible truth label and native lifeline', async () => {
    await render();
    expect(container.querySelector('[data-testid="f257-journey-truth-label"]')?.textContent).toContain('演示数据');
    expect(container.textContent).toContain('版本生命线');
    expect(container.textContent).toContain('TraceAnnotationCommitted');
  });

  it('lets the operator approve the projected Candidate from the product card', async () => {
    await render();
    await click('f257-journey-next');
    await click('f257-journey-next');

    expect(container.querySelector('[data-testid="f257-journey-approval-card"]')).not.toBeNull();
    expect(container.textContent).toContain('governance(1 待审)');
    expect(container.textContent).toContain('系统自动创建');
    expect(container.textContent).toContain('用户无需触发 governance');
    expect(container.textContent).toContain('目标段');
    await click('f257-journey-approve');
    expect(container.textContent).toContain('CandidateDecisionApproved');
    expect(container.textContent).toContain('系统自动执行');
    expect(container.querySelector('[data-testid="f257-journey-resume"]')).toBeNull();
  });

  it('shows an explicit evaluation evidence chain before the conclusion', async () => {
    await render();
    await click('f257-journey-next');

    const evidence = container.querySelector('[data-testid="f257-journey-evaluation-evidence"]');
    expect(evidence?.textContent).toContain('snapshot-s13-schema-failure');
    expect(evidence?.textContent).toContain('2026-08-24T12:00:00.000Z');
    expect(evidence?.textContent).toContain('InjectionTrace summary');
    expect(evidence?.textContent).toContain('tool-schema-failure-count');
    expect(evidence?.textContent).toContain('counter-zero');
    expect(evidence?.textContent).toContain('count = 3');
    expect(evidence?.textContent).toContain('retire-candidate');
  });

  it('shows interrupted execution as resume-only with no premature PatchTrial', async () => {
    await render();
    await click('f257-journey-scenario-recovery');
    for (let index = 0; index < 4; index++) await click('f257-journey-next');

    expect(container.textContent).toContain('OverrideExecutionInterrupted');
    expect(container.textContent).toContain('继续执行');
    expect(container.textContent).toContain('尚未创建 PatchTrial');
    expect(container.textContent).toContain('不需要再次批准');
    expect(container.querySelector('[data-testid="f257-journey-approve"]')).toBeNull();
  });

  it('ends only after the improved treatment window closes the Candidate', async () => {
    await render();
    for (let index = 0; index < 6; index++) await click('f257-journey-next');

    expect(container.textContent).toContain('PatchTrialClosed');
    expect(container.textContent).toContain('improved');
    expect(container.textContent).toContain('solidify');
    expect(container.textContent).toContain('Candidate closed');
    expect((container.querySelector('[data-testid="f257-journey-next"]') as HTMLButtonElement).disabled).toBe(false);
    await click('f257-journey-next');
    expect(container.textContent).toContain('下一回合');
    expect(container.textContent).toContain('当前循环回到 tracing');
    expect((container.querySelector('[data-testid="f257-journey-next"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it('collects a rejection reason and shows the no-intervention loop into the next eval window', async () => {
    await render();
    await click('f257-journey-next');
    await click('f257-journey-next');
    await click('f257-journey-reject');
    await type('f257-journey-reject-reason', '反例来自已退役工具别名；下一窗口按新工具目录重评。');
    await click('f257-journey-confirm-reject');

    expect(container.textContent).toContain('CandidateDecisionRejected');
    expect(container.textContent).toContain('反例来自已退役工具别名');
    expect(container.textContent).toContain('没有写入 override');
    expect(container.textContent).toContain('尚未创建 PatchTrial');

    await click('f257-journey-next');
    expect(container.textContent).toContain('下一回合');
    expect(container.textContent).toContain('当前循环回到 tracing');
    expect(container.textContent).toContain('Candidate.approval.note');
    expect(container.textContent).toContain('需要后端触点');
  });
});
