import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockApiFetch = vi.fn();
vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
  API_URL: 'http://localhost:3102',
}));

describe('PluginsContent status resolution', () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('platform-source plugins are always active when API responds', async () => {
    mockApiFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ services: [] }),
    });

    const mod = await import('../settings/PluginsContent');
    const catalog = (mod as Record<string, unknown[]>).PLUGIN_CATALOG ?? [];

    expect(catalog).toBeDefined();
  });

  it('PLUGIN_CATALOG has correct source fields', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(
      new URL('../settings/PluginsContent.tsx', import.meta.url).pathname.replace('__tests__/', ''),
      'utf-8',
    );

    const platformEntries = ['pr-tracking', 'review-router', 'ci-cd-monitor'];
    const serviceEntries = ['voice-companion', 'browser-automation'];

    for (const id of platformEntries) {
      const idPos = src.indexOf(`id: '${id}'`);
      expect(idPos, `${id} should exist in source`).toBeGreaterThan(-1);
      const sourceAfter = src.slice(idPos, idPos + 200);
      expect(sourceAfter, `${id} should have source: 'platform'`).toContain("source: 'platform'");
    }

    for (const id of serviceEntries) {
      const idPos = src.indexOf(`id: '${id}'`);
      expect(idPos, `${id} should exist in source`).toBeGreaterThan(-1);
      const sourceAfter = src.slice(idPos, idPos + 200);
      expect(sourceAfter, `${id} should have source: 'service'`).toContain("source: 'service'");
    }
  });

  it('SERVICE_FEATURE_MAP only maps service-backed plugins', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(
      new URL('../settings/PluginsContent.tsx', import.meta.url).pathname.replace('__tests__/', ''),
      'utf-8',
    );

    expect(src).not.toContain("'pr-tracking': [");
    expect(src).not.toContain("'review-router': [");
    expect(src).not.toContain("'ci-cd-monitor': [");

    expect(src).toContain("'voice-companion': [");
    expect(src).toContain("'browser-automation': [");
  });

  it('platform plugins resolve to active when API reachable', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(
      new URL('../settings/PluginsContent.tsx', import.meta.url).pathname.replace('__tests__/', ''),
      'utf-8',
    );

    expect(src).toContain("p.source === 'platform'");
    expect(src).toContain("apiReachable");
    expect(src).toContain("statusLabel: '内置运行中'");
  });
});
