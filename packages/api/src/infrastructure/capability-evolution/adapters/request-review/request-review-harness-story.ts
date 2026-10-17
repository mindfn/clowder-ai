import type { EvolutionExplorationNodeV1, OwnerTruthRefV1 } from '@cat-cafe/shared';
import type { RequestReviewHarnessLineageIndex } from './request-review-harness-lineage-schema.js';

type Story = NonNullable<RequestReviewHarnessLineageIndex['story']>;
type Case = RequestReviewHarnessLineageIndex['cases'][number];
const sourceRef = (index: RequestReviewHarnessLineageIndex, id: string): OwnerTruthRefV1 => ({
  ownerFeatureId: 'F314',
  ownerStateRef: `harness-history:story-source:${id}`,
  version: index.snapshotCommit,
});

export const harnessStoryNodeRef = (
  index: RequestReviewHarnessLineageIndex,
  id: string,
  version?: string,
): OwnerTruthRefV1 => ({
  ownerFeatureId: 'F314',
  ownerStateRef: `harness-history:story:${id}`,
  version: version ?? index.snapshotCommit,
});

function source(index: RequestReviewHarnessLineageIndex, id: string) {
  const entry = index.story?.sources.find((value) => value.id === id);
  if (!entry) throw new Error('validated story source disappeared');
  return {
    label: entry.label,
    ref: sourceRef(index, id),
    href: `https://github.com/zts212653/clowder-ai/blob/${index.snapshotCommit}/${entry.path}`,
  };
}

export function storyCaseNarrative(index: RequestReviewHarnessLineageIndex, entry: Case) {
  return index.story?.cases.find((value) => value.caseId === entry.caseId);
}

export function storyCaseSources(index: RequestReviewHarnessLineageIndex, entry: Case) {
  return storyCaseNarrative(index, entry)?.sourceIds.map((id) => source(index, id)) ?? [];
}

export function projectHarnessStoryNodes(
  index: RequestReviewHarnessLineageIndex,
  story: Story,
  publicationRef?: OwnerTruthRefV1,
): EvolutionExplorationNodeV1[] {
  return story.nodes.map((node) => ({
    kind: 'public_archive',
    nodeRef: harnessStoryNodeRef(index, node.id, publicationRef?.version),
    title: node.title,
    summary: node.summary,
    history: { period: node.when, updatedThrough: story.updated },
    sourceRef: publicationRef ?? sourceRef(index, 'evolution-story'),
    changes: node.changes.map((change) => ({
      label: change.label,
      detail: change.detail,
      sourceRef: sourceRef(index, change.sourceId),
      ownerHref: source(index, change.sourceId).href,
    })),
    parentEdges: node.parents.map((parent) => ({
      parentNodeRef: harnessStoryNodeRef(index, parent.nodeId, publicationRef?.version),
      description: parent.reason,
      sourceRef: sourceRef(index, parent.sourceId),
    })),
  }));
}
