/**
 * #1307 regression: a running conversation has one whole-thread Stop in the
 * composer. Status chrome may expose per-cat Stop, but never another all-stop.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const componentDir = join(import.meta.dirname, '..');

describe('Conversation Stop ownership invariant', () => {
  it('keeps the active-invocation banner informational', async () => {
    const source = await readFile(join(componentDir, 'ChatInput.tsx'), 'utf-8');
    const bannerIdx = source.indexOf('hasActiveInvocation && (');
    expect(bannerIdx).toBeGreaterThan(-1);
    const bannerBlock = source.slice(bannerIdx, source.indexOf(')}', bannerIdx) + 2);

    expect(bannerBlock).toContain('data-testid="active-invocation-banner"');
    expect(bannerBlock).not.toContain('banner-cancel-btn');
  });

  it('keeps liveness and parallel-status chrome informational', async () => {
    const [thinkingIndicator, parallelStatusBar] = await Promise.all([
      readFile(join(componentDir, 'ThinkingIndicator.tsx'), 'utf-8'),
      readFile(join(componentDir, 'ParallelStatusBar.tsx'), 'utf-8'),
    ]);

    expect(thinkingIndicator).not.toContain('data-testid="cancel-btn"');
    expect(parallelStatusBar).not.toContain('data-testid="parallel-stop-button"');
  });

  it('reserves the sole whole-thread Stop for the composer and per-cat stop for execution status', async () => {
    const [actionButton, executionBar] = await Promise.all([
      readFile(join(componentDir, 'ChatInputActionButton.tsx'), 'utf-8'),
      readFile(join(componentDir, 'ThreadExecutionBar.tsx'), 'utf-8'),
    ]);

    expect(actionButton).toContain('aria-label="停止对话"');
    expect(executionBar).toContain(`/cancel/\${catId}`);
    expect(executionBar).not.toContain('force-reset');
    expect(executionBar).not.toContain('thread-stop-entry');
  });
});
