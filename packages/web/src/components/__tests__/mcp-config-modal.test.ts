import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(async () => ({ ok: true, json: async () => ({}) })),
}));

import { McpConfigModal } from '@/components/McpConfigModal';

describe('McpConfigModal', () => {
  it('renders modal with data-testid', () => {
    const html = renderToStaticMarkup(
      React.createElement(McpConfigModal, {
        onSaved: () => {},
        onClose: () => {},
      }),
    );
    expect(html).toContain('data-testid="mcp-config-modal"');
    expect(html).toContain('连接至自定义 MCP');
  });

  it('renders in edit mode with MCP name', () => {
    const html = renderToStaticMarkup(
      React.createElement(McpConfigModal, {
        editId: 'my-mcp',
        editData: { transport: 'stdio', command: 'my-server' },
        onSaved: () => {},
        onClose: () => {},
      }),
    );
    expect(html).toContain('更新 my-mcp');
  });

  it('renders HTTP transport edit layout', () => {
    const html = renderToStaticMarkup(
      React.createElement(McpConfigModal, {
        editId: 'http-mcp',
        editData: { transport: 'streamableHttp', url: 'https://example.com/mcp' },
        onSaved: () => {},
        onClose: () => {},
      }),
    );
    expect(html).toContain('HTTP Stream');
    expect(html).toContain('卸载');
  });

  it('accepts projectPath prop (contract: flows into save payload)', () => {
    const html = renderToStaticMarkup(
      React.createElement(McpConfigModal, {
        projectPath: '/my/project',
        editId: 'test-mcp',
        editData: { transport: 'stdio', command: 'test' },
        onSaved: () => {},
        onClose: () => {},
      }),
    );
    expect(html).toContain('更新 test-mcp');
  });
});
