// @vitest-environment jsdom

import type { SegmentEnablementMatrix } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActivateVersionButton, RollbackButton, ToggleOverrideButton } from '../VersionActions';

const apiFetch = vi.fn();

vi.mock('../../../utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

function makeMatrix(overrides: Partial<SegmentEnablementMatrix> = {}): SegmentEnablementMatrix {
  return {
    segmentId: 'S6',
    safetyTier: 'editable',
    allowLocalOverride: true,
    disableable: true,
    overrideState: { enabled: true, hasOverride: false, hasContentOverride: false, hasBackup: false },
    actions: {
      edit: { allowed: true, reason: null, reasonCode: null },
      disable: { allowed: true, reason: null, reasonCode: null },
      enable: { allowed: false, reason: '当前段已启用', reasonCode: 'already-enabled' },
      rollback: { allowed: false, reason: '当前段无覆盖可回滚', reasonCode: 'no-override' },
      restoreBackup: { allowed: false, reason: '当前段无备份文件', reasonCode: 'no-backup' },
      activateVersion: { allowed: true, reason: null, reasonCode: null },
    },
    ...overrides,
  };
}

describe('VersionActions (F257 Console 判据⑥)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    apiFetch.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('ToggleOverrideButton is disabled and shows reason when matrix disallows disable', () => {
    act(() => {
      root.render(
        <ToggleOverrideButton
          hookId="S6"
          currentlyEnabled
          onRefresh={() => {}}
          enablementMatrix={makeMatrix({
            actions: {
              edit: { allowed: true, reason: null, reasonCode: null },
              disable: { allowed: false, reason: '当前段 disableable=false，不可禁用', reasonCode: 'not-disableable' },
              enable: { allowed: false, reason: '当前段已启用', reasonCode: 'already-enabled' },
              rollback: { allowed: false, reason: '当前段无覆盖可回滚', reasonCode: 'no-override' },
              restoreBackup: { allowed: false, reason: '当前段无备份文件', reasonCode: 'no-backup' },
              activateVersion: {
                allowed: false,
                reason: '当前段无内容覆盖版本可激活',
                reasonCode: 'no-content-override',
              },
            },
          })}
        />,
      );
    });

    const button = container.querySelector('button') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(container.textContent).toContain('当前段 disableable=false，不可禁用');
  });

  it('RollbackButton is disabled and shows reason when matrix disallows rollback', () => {
    act(() => {
      root.render(
        <RollbackButton
          hookId="S6"
          onRefresh={() => {}}
          enablementMatrix={makeMatrix({
            actions: {
              edit: { allowed: true, reason: null, reasonCode: null },
              disable: { allowed: true, reason: null, reasonCode: null },
              enable: { allowed: false, reason: '当前段已启用', reasonCode: 'already-enabled' },
              rollback: { allowed: false, reason: '当前段无覆盖可回滚', reasonCode: 'no-override' },
              restoreBackup: { allowed: false, reason: '当前段无备份文件', reasonCode: 'no-backup' },
              activateVersion: {
                allowed: false,
                reason: '当前段无内容覆盖版本可激活',
                reasonCode: 'no-content-override',
              },
            },
          })}
        />,
      );
    });

    const button = container.querySelector('button') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(container.textContent).toContain('当前段无覆盖可回滚');
  });

  it('ActivateVersionButton is disabled and shows reason when matrix disallows activateVersion', () => {
    act(() => {
      root.render(
        <ActivateVersionButton
          hookId="S6"
          epochVersion={2}
          onRefresh={() => {}}
          enablementMatrix={makeMatrix({
            actions: {
              edit: { allowed: true, reason: null, reasonCode: null },
              disable: { allowed: true, reason: null, reasonCode: null },
              enable: { allowed: false, reason: '当前段已启用', reasonCode: 'already-enabled' },
              rollback: { allowed: false, reason: '当前段无覆盖可回滚', reasonCode: 'no-override' },
              restoreBackup: { allowed: false, reason: '当前段无备份文件', reasonCode: 'no-backup' },
              activateVersion: {
                allowed: false,
                reason: '当前段 safetyTier=readonly，禁止激活版本',
                reasonCode: 'safety-tier-readonly',
              },
            },
          })}
        />,
      );
    });

    const button = container.querySelector('button') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(container.textContent).toContain('当前段 safetyTier=readonly，禁止激活版本');
  });

  it('ToggleOverrideButton triggers API when allowed and reason provided', async () => {
    apiFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) });
    const onRefresh = vi.fn();

    act(() => {
      root.render(
        <ToggleOverrideButton hookId="S6" currentlyEnabled onRefresh={onRefresh} enablementMatrix={makeMatrix()} />,
      );
    });

    const button = container.querySelector('button') as HTMLButtonElement;
    expect(button.disabled).toBe(false);

    vi.spyOn(window, 'confirm').mockReturnValueOnce(true);
    vi.spyOn(window, 'prompt').mockReturnValueOnce('test reason');
    act(() => {
      button.click();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    expect(apiFetch).toHaveBeenCalledWith(
      '/api/prompt-hooks/S6/override',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ action: 'disable', reason: 'test reason' }),
      }),
    );
    expect(onRefresh).toHaveBeenCalled();
  });
});
