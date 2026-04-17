// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import {
  findGuideTarget,
  GUIDE_STEP_CONFIG,
  hasAnyGuideTarget,
  hostSelector,
  matchesGuideTarget,
  PREVIOUS_GUIDE_STEP,
  targetSelector,
} from '../guideStepConfig';

describe('guideStepConfig', () => {
  it('keeps the expected fallback chain for stale persisted guide steps', () => {
    expect(PREVIOUS_GUIDE_STEP['click-add-member']).toBe('open-hub');
    expect(PREVIOUS_GUIDE_STEP['fill-form']).toBe('click-add-member');
  });

  it('keeps host elevation metadata for modal-based guide steps', () => {
    expect(GUIDE_STEP_CONFIG['click-add-member'].hosts).toEqual(['hub-modal']);
    expect(GUIDE_STEP_CONFIG['fill-form'].hosts).toEqual(['hub-modal', 'cat-editor-modal']);
  });

  it('finds and matches guide targets through shared selector helpers', () => {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = `
      <div data-bootcamp-host="hub-modal">
        <button data-bootcamp-step="add-member-button">
          <span data-testid="label">+ 添加成员</span>
        </button>
      </div>
    `;
    document.body.appendChild(wrapper);

    const matched = document.querySelector('[data-testid="label"]');
    const target = findGuideTarget(['missing-step', 'add-member-button']);

    expect(targetSelector('add-member-button')).toBe('[data-bootcamp-step="add-member-button"]');
    expect(hostSelector('hub-modal')).toBe('[data-bootcamp-host="hub-modal"]');
    expect(hasAnyGuideTarget(['add-member-button'])).toBe(true);
    expect(target).toBeInstanceOf(HTMLElement);
    expect(matchesGuideTarget(matched as Element, ['add-member-button'])).toBe(true);

    wrapper.remove();
  });
});
