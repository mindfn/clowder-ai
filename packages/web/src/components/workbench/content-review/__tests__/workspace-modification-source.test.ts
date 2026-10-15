import { describe, expect, it } from 'vitest';
import { workspaceReviewRequestSource } from '../workspace-modification-source';
import { mediaView, reviewId, revision } from './WorkspaceContentReviewSurface.fixture';

describe('workspaceReviewRequestSource — the one source a request or a chat attachment names', () => {
  it('names an ordinary workspace file by its locator, version and the review that holds it', () => {
    const view = mediaView();
    expect(workspaceReviewRequestSource(view)).toEqual({
      kind: 'workspace',
      locator: { worktreeId: 'worktree-a', path: 'cover.png' },
      expectedSourceRevision: revision,
      reviewId,
      expectedReviewRevision: view.review.revision,
    });
  });

  it('names a publication by its owner revision and the ledger that carries the discussion', () => {
    const view = mediaView();
    Object.assign(view.review, {
      source: { kind: 'publication', publication: { contentRef: 'content-1', ownerRevision: 4 }, mime: 'image/png' },
    });
    expect(workspaceReviewRequestSource(view)).toEqual({
      kind: 'publication',
      contentRef: 'content-1',
      ownerRevision: 4,
      ledgerRef: reviewId,
      expectedLedgerRevision: view.review.revision,
    });
  });

  it('names an evolution result by its locator and the review it was made in', () => {
    const view = mediaView();
    Object.assign(view.review.source, { kind: 'evolution' });
    expect(workspaceReviewRequestSource(view)).toEqual({
      kind: 'evolution',
      locator: { worktreeId: 'worktree-a', path: 'cover.png' },
      expectedSourceRevision: revision,
      reviewId,
      expectedReviewRevision: view.review.revision,
    });
  });

  it('reads the review source, not a newer current source: a request is bound to the version that was reviewed', () => {
    const view = mediaView();
    const newer = { ...view.review.source, revision: `sha256:${'f'.repeat(64)}` };
    const withCurrent = { ...view, currentSource: newer };
    expect(workspaceReviewRequestSource(withCurrent)).toMatchObject({ expectedSourceRevision: revision });
  });
});
