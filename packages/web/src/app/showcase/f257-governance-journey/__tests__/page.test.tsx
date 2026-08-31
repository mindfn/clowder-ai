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
    expect(container.textContent).toContain('目标段');
    await click('f257-journey-approve');
    expect(container.textContent).toContain('CandidateDecisionApproved');
    expect(container.textContent).toContain('继续执行');
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
    expect((container.querySelector('[data-testid="f257-journey-next"]') as HTMLButtonElement).disabled).toBe(true);
  });
});
