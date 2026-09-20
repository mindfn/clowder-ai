import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SETTINGS_SECTIONS } from '../settings-nav-config';

const SETTINGS_CONTENT_PATH = resolve(__dirname, '../SettingsContent.tsx');

describe('F190 Settings destination sections', () => {
  it('promotes each converged destination to its own Settings section', () => {
    const ids = SETTINGS_SECTIONS.map((section) => section.id);

    expect(ids).not.toContain('destinations');
    expect(ids.slice(3, 6)).toEqual(['memory', 'mission-hub', 'signals']);
    expect(SETTINGS_SECTIONS.find((section) => section.id === 'memory')?.label).toBe('记忆');
    expect(SETTINGS_SECTIONS.find((section) => section.id === 'mission-hub')?.label).toBe('Mission Hub');
    expect(SETTINGS_SECTIONS.find((section) => section.id === 'signals')?.label).toBe('信号');
  });

  it('keeps System settings as the final secondary section', () => {
    expect(SETTINGS_SECTIONS.at(-1)?.id).toBe('system');
  });

  it('wires the three sections directly to their existing full surfaces', () => {
    const source = readFileSync(SETTINGS_CONTENT_PATH, 'utf8');

    expect(source).toContain("section === 'memory'");
    expect(source).toContain('<MemoryHub');
    expect(source).toContain("section === 'mission-hub'");
    expect(source).toContain('<MissionControlPage');
    expect(source).toContain("section === 'signals'");
    expect(source).toContain('<SignalInboxView');
    expect(source).not.toContain('FeatureDestinationsContent');
  });
});
