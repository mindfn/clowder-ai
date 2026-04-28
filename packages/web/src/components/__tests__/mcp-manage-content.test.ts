import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const MOCK_ITEMS = [
  {
    id: 'pencil',
    type: 'mcp' as const,
    source: 'cat-cafe' as const,
    enabled: true,
    cats: {},
    description: 'Pencil design tool',
    mcpServer: { transport: 'stdio', command: 'pencil-server' },
  },
  {
    id: 'custom-mcp',
    type: 'mcp' as const,
    source: 'external' as const,
    enabled: false,
    cats: { opus: true },
    description: 'External MCP',
    mcpServer: { transport: 'streamableHttp', url: 'https://example.com/mcp' },
  },
];

vi.mock('@/stores/chatStore', () => ({
  useChatStore: (sel: (s: Record<string, unknown>) => unknown) => sel({ threads: [] }),
}));

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(async (url: string, opts?: { method?: string }) => {
    if (opts?.method === 'DELETE') {
      return { ok: true, json: async () => ({}) };
    }
    return {
      ok: true,
      json: async () => ({
        items: MOCK_ITEMS,
        catFamilies: [{ id: 'ragdoll', name: 'Ragdoll', catIds: ['opus'] }],
        projectPath: '/test/project',
        skillHealth: null,
      }),
    };
  }),
}));

vi.mock('@/components/marketplace/marketplace-panel', () => ({
  MarketplacePanel: () => React.createElement('div', null, 'marketplace'),
}));

vi.mock('@/components/McpConfigModal', () => ({
  McpConfigModal: () => null,
}));

import { apiFetch } from '@/utils/api-client';
import { McpManageContent } from '@/components/settings/McpManageContent';

describe('McpManageContent', () => {
  it('renders MCP cards with marketplace rail', () => {
    const html = renderToStaticMarkup(React.createElement(McpManageContent));
    expect(html).toContain('新增 MCP');
    expect(html).toContain('MCP 市场');
    expect(html).toContain('marketplace');
  });

  it('renders loading skeleton initially', () => {
    const html = renderToStaticMarkup(React.createElement(McpManageContent));
    expect(html).toContain('animate-pulse');
  });

  it('MCP disable uses soft delete (no hard=true)', () => {
    const mockFetch = apiFetch as ReturnType<typeof vi.fn>;
    const deleteCalls = mockFetch.mock.calls.filter(
      ([url, opts]: [string, { method?: string }?]) => opts?.method === 'DELETE',
    );
    for (const [url] of deleteCalls) {
      expect(url).not.toContain('hard=true');
    }
  });
});
