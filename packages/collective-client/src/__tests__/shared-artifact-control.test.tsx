// @vitest-environment jsdom
import type { CollectiveModificationProjection } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { SharedArtifact, SharedMarkdownView } from '../collective-artifact-client.js';
import { SharedArtifactModificationCompare } from '../SharedArtifactModificationCompare.js';
import { SharedArtifactRequestCards } from '../SharedArtifactRequestCards.js';
import { CollectiveArtifactContext, type CollectiveArtifactState } from '../use-collective-artifacts.js';

vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
it('lets the requester cancel only its request and an authorized adopter decline a candidate without hiding its comparison', async () => {
  const request = {
    requestId: 'request',
    revision: 2,
    state: 'proposal_ready',
    ownerRevision: 1,
    requestingHumanId: 'requester',
    target: { humanId: 'cat-owner', catId: 'sol' },
    annotationIds: ['note'],
    latestProposalRef: 'candidate',
    sourceEventId: 'source',
  } as CollectiveModificationProjection;
  const artifact = {
    artifactId: 'artifact',
    contentRef: 'content',
    canApply: true,
    versions: [{ ownerRevision: 1 }],
  } as unknown as SharedArtifact;
  const view = {
    contentRef: 'content',
    view: { review: { revision: 1 } },
    modifications: { requests: [request] },
  } as unknown as SharedMarkdownView;
  const resolveModification = vi.fn(async (_artifact, _request, action) => ({
    ...request,
    state: 'cancelled',
    resolution: { kind: action === 'cancel' ? 'cancelled' : 'rejected' },
  }));
  const state = {
    catalogue: [artifact],
    humanId: 'requester',
    catName: () => 'Sol',
    sourceMessage: () => undefined,
    refresh: async () => {},
    compare: vi.fn(),
    api: {
      resolveModification,
      previewModification: async () => ({ request, proposal: { response: '保留的候选', edits: [] } }),
    },
  } as unknown as CollectiveArtifactState;
  const host = document.createElement('div');
  const root = createRoot(host);
  const render = (comparison: boolean) =>
    root.render(
      <CollectiveArtifactContext.Provider value={state}>
        {comparison ? (
          <SharedArtifactModificationCompare artifact={artifact} request={request} onClose={() => {}} />
        ) : (
          <SharedArtifactRequestCards view={view} />
        )}
      </CollectiveArtifactContext.Provider>,
    );
  try {
    await act(async () => render(false));
    const cancel = Array.from(host.querySelectorAll('button')).find((button) => button.textContent === '取消这次修改');
    expect(cancel).toBeDefined();
    await act(async () => cancel?.click());
    expect(resolveModification).toHaveBeenLastCalledWith(artifact, request, 'cancel');
    expect(host.textContent).toContain('已取消');
    expect(host.textContent).toContain('查看对照');
    await act(async () => render(true));
    const decline = Array.from(host.querySelectorAll('button')).find((button) => button.textContent === '不采用');
    expect(decline).toBeDefined();
    await act(async () => decline?.click());
    expect(resolveModification).toHaveBeenLastCalledWith(artifact, request, 'reject');
    expect(host.textContent).toContain('未采用');
    expect(host.textContent).toContain('保留的候选');
    expect(Array.from(host.querySelectorAll('button')).some((button) => button.textContent === '采用')).toBe(false);
  } finally {
    await act(async () => root.unmount());
  }
});
