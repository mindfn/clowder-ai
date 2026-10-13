import { beforeEach, expect, it, vi } from 'vitest';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));

import { apiFetch } from '@/utils/api-client';
import { fetchManagerDetail } from '../plugin-manager-live-api';

const mockFetch = vi.mocked(apiFetch);
beforeEach(() => {
  mockFetch.mockReset();
});

it('loads Host-bundled dot setup without requesting a nonexistent package archive README', async () => {
  const id = 'official.chatgpt-dot';
  mockFetch.mockImplementation(
    async (url) =>
      new Response(
        JSON.stringify(
          url === `/api/plugin-manager/plugins/${id}`
            ? { plugin: { pluginId: id, artifact: 'installed', live: 'stopped' }, catalog: { status: 'fresh' } }
            : { error: 'archive unavailable' },
        ),
        { status: url.endsWith('/documentation') ? 422 : 200 },
      ),
  );
  const detail = await fetchManagerDetail(id, false);
  expect(detail.pluginId).toBe(id);
  expect(mockFetch.mock.calls.map(([url]) => url)).not.toContain(`/api/plugin-manager/plugins/${id}/documentation`);
});

it('keeps package README discovery for ordinary catalog plugins', async () => {
  const id = 'ordinary.plugin';
  mockFetch.mockImplementation(
    async (url) =>
      new Response(
        JSON.stringify(
          url.endsWith('/documentation')
            ? { readmeMarkdown: '# Ordinary package' }
            : { plugin: { pluginId: id, artifact: 'installed', live: 'stopped' }, catalog: { status: 'fresh' } },
        ),
      ),
  );
  const detail = await fetchManagerDetail(id, false);
  expect(detail.readme).toEqual({ state: 'available', markdown: '# Ordinary package' });
});
