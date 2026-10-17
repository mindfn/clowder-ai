import {
  type EvolutionArchivePublicationV1,
  type EvolutionExplorationSelectionV1,
  type EvolutionResolvedExplorationReviewV1,
  refIdentity,
} from '@cat-cafe/shared';

type Catalog = EvolutionResolvedExplorationReviewV1;
type Ref = Catalog['sourceRef'];
const sameLogicalRef = (a: Ref, b: Ref) => a.ownerFeatureId === b.ownerFeatureId && a.ownerStateRef === b.ownerStateRef;

/** Called only with the two verified owner publications; clients never strip versions themselves. */
export function mapHarnessHistorySelection(
  previous: Catalog,
  current: Catalog,
  selection: EvolutionExplorationSelectionV1,
): NonNullable<EvolutionArchivePublicationV1['selectionUpdate']> {
  const next: EvolutionExplorationSelectionV1 = { selectedSourceRef: current.sourceRef };
  let kind: 'unchanged' | 'modified' | 'moved' = 'unchanged';
  for (const key of ['selectedExperimentRef', 'comparisonExperimentRef'] as const) {
    const selected = selection[key];
    if (!selected) continue;
    const oldExperiment = previous.experiments.find(
      (item) => refIdentity(item.experimentRef) === refIdentity(selected),
    );
    const newExperiment = current.experiments.find((item) => sameLogicalRef(item.experimentRef, selected));
    if (!oldExperiment || !newExperiment) return { kind: 'removed' };
    next[key] = newExperiment.experimentRef;
    if (!sameLogicalRef(oldExperiment.nodeRef, newExperiment.nodeRef)) {
      if (key === 'comparisonExperimentRef') return { kind: 'removed' };
      next.selectedNodeRef = newExperiment.nodeRef;
      kind = 'moved';
    }
    const oldDetail = previous.details.find((item) => refIdentity(item.experimentRef) === refIdentity(selected));
    const newDetail = current.details.find(
      (item) => refIdentity(item.experimentRef) === refIdentity(newExperiment.experimentRef),
    );
    const body = (detail: typeof oldDetail) =>
      detail?.status === 'resolved'
        ? JSON.stringify(
            detail.records.map((record) => [record.label, record.input, record.output, record.result, record.sources]),
          )
        : detail?.status;
    if (kind === 'unchanged' && (oldExperiment.title !== newExperiment.title || body(oldDetail) !== body(newDetail)))
      kind = 'modified';
  }
  if (selection.selectedNodeRef) {
    const selectedNode = selection.selectedNodeRef;
    const oldNode = previous.nodes.find((node) => refIdentity(node.nodeRef) === refIdentity(selectedNode));
    const targetNode = next.selectedNodeRef ?? selectedNode;
    const newNode = current.nodes.find((node) => sameLogicalRef(node.nodeRef, targetNode));
    if (!oldNode || !newNode) return { kind: 'removed' };
    next.selectedNodeRef = newNode.nodeRef;
    // Ignore publication identity changes, but include all visible reading metadata.
    const body = (node: typeof oldNode, catalog: Catalog) =>
      JSON.stringify({
        title: node.title,
        summary: node.summary,
        history: node.kind === 'public_archive' ? node.history : undefined,
        changes: node.changes.map((change) => [change.label, change.detail, change.ownerHref]),
        parents: node.parentEdges.map((edge) => [edge.parentNodeRef.ownerStateRef, edge.description]),
        cases: catalog.experiments
          .filter((item) => sameLogicalRef(item.nodeRef, node.nodeRef))
          .map((item) => [item.experimentRef.ownerStateRef, item.title, item.conditions.window.label]),
      });
    if (kind === 'unchanged' && body(oldNode, previous) !== body(newNode, current)) kind = 'modified';
  }
  return { kind, nextSelection: next };
}
