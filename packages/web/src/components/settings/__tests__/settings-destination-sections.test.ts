import { describe, expect, it } from 'vitest';
import { SETTINGS_SECTIONS } from '../settings-nav-config';

describe('F190 Settings destination sections', () => {
  it('promotes each converged destination to its own Settings section', () => {
    const ids = SETTINGS_SECTIONS.map((section) => section.id);
    const accountsIndex = ids.indexOf('accounts');
    const memoryIndex = ids.indexOf('memory');
    const missionIndex = ids.indexOf('mission-hub');
    const signalsIndex = ids.indexOf('signals');

    expect(ids).not.toContain('destinations');
    expect(memoryIndex).toBe(accountsIndex + 1);
    expect(missionIndex).toBe(memoryIndex + 1);
    expect(signalsIndex).toBe(missionIndex + 1);
    expect(SETTINGS_SECTIONS.find((section) => section.id === 'memory')?.label).toBe('记忆');
    expect(SETTINGS_SECTIONS.find((section) => section.id === 'mission-hub')?.label).toBe('Mission Hub');
    expect(SETTINGS_SECTIONS.find((section) => section.id === 'signals')?.label).toBe('信号');
  });

  it('keeps System settings as the final secondary section', () => {
    expect(SETTINGS_SECTIONS.at(-1)?.id).toBe('system');
  });
});
