import { expect, it, vi } from 'vitest';
import { readArtifactJsonPages, SharedArtifactCatalogueReconciled } from '../collective-artifact-client.js';

it('reads the exact complete escaped owner snapshot and never returns a partially assembled document', async () => {
  const source = JSON.stringify({ text: '# 原文\n'.repeat(10000), annotations: ['正文中的选区'] });
  const seen: Record<string, unknown>[] = [];
  const result = await readArtifactJsonPages(async (page) => {
    seen.push(page);
    const cursor = typeof page.cursor === 'number' ? page.cursor : 0;
    return {
      encoding: 'json-text-chunk',
      snapshot: 'same-owner-snapshot',
      json: source.slice(cursor, cursor + 1024),
      nextCursor: cursor + 1024 < source.length ? cursor + 1024 : null,
    };
  });
  expect(result).toEqual(JSON.parse(source));
  expect(seen.length).toBeGreaterThan(10);
  expect(seen[1]).toEqual({ cursor: 1024, expectedSnapshot: 'same-owner-snapshot' });
});

it('refreshes a reconciled catalogue before requesting another body page from a now newer owner revision', async () => {
  const read = vi.fn(async () => ({
    encoding: 'json-text-chunk',
    snapshot: 'old-version',
    json: '{',
    nextCursor: 1,
    catalogueReconciled: true,
  }));
  await expect(readArtifactJsonPages(read)).rejects.toBeInstanceOf(SharedArtifactCatalogueReconciled);
  expect(read).toHaveBeenCalledOnce();
});

it('refuses a changed owner snapshot and broken cursors rather than displaying mixed versions', async () => {
  const read = vi
    .fn()
    .mockResolvedValueOnce({ encoding: 'json-text-chunk', snapshot: 'first', json: '{"text":', nextCursor: 8 })
    .mockResolvedValueOnce({ encoding: 'json-text-chunk', snapshot: 'second', json: '"wrong"}', nextCursor: null });
  await expect(readArtifactJsonPages(read)).rejects.toThrow('更新');
  await expect(
    readArtifactJsonPages(async () => ({ encoding: 'json-text-chunk', snapshot: 'first', json: '{', nextCursor: 0 })),
  ).rejects.toThrow('未完成');
});
