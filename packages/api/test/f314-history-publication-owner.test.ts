import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { evolutionExplorationReviewV1Schema, refIdentity } from '@cat-cafe/shared';
import { HarnessHistorySourceError } from '../src/infrastructure/capability-evolution/adapters/request-review/harness-history-git-source.js';
import { HarnessHistoryPublicationOwner } from '../src/infrastructure/capability-evolution/adapters/request-review/harness-history-publication-owner.js';
import { MemoryHarnessHistoryPublicationStore } from '../src/infrastructure/capability-evolution/adapters/request-review/harness-history-publication-store.js';

const archive = JSON.parse(
  readFileSync(
    new URL('../../../docs/discussions/f314-incident-archive/lineage/lineage-index.json', import.meta.url),
    'utf8',
  ),
);
const input = {
  programRef: { ownerFeatureId: 'F311', ownerStateRef: `evolution-program:${'1'.repeat(32)}` },
  objectRef: { ownerFeatureId: 'F100', ownerStateRef: 'capability:development-process-harness-effectiveness' },
};
const actor = { actorRef: 'cat:codex-astra', originRef: 'thread:fixture:invocation:writer' };
const a = 'a'.repeat(40),
  b = 'b'.repeat(40),
  c = 'c'.repeat(40);
function fixture() {
  const next = structuredClone(archive);
  next.story.nodes[0].summary = '新补的后续结果';
  const store = new MemoryHarnessHistoryPublicationStore();
  const source = {
    baseline: async () => a,
    read: async (revision: string) => (revision === b ? next : archive),
    acquire: async (revision: string) => {
      if (revision === c) throw new HarnessHistorySourceError('source_unavailable');
      return revision === b ? next : archive;
    },
  };
  return { store, source, owner: new HarnessHistoryPublicationOwner({ store, source }), next };
}
const publish = (revision: number, sourceRevision = b, clientMessageId = `publish-${revision}`) => ({
  action: 'publish' as const,
  expectedRevision: revision,
  sourceRevision,
  clientMessageId,
  reason: '补上有来源的后续结果',
});

test('same running owner publishes B, exact A remains A, failed publication preserves B, restore appends and replay preserves the original receipt', async () => {
  const { owner, store, source } = fixture();
  const initial = await owner.read(input);
  assert.equal(initial.status, 'resolved');
  if (initial.status !== 'resolved') return;
  const selected = { ...input, selectedSourceRef: initial.sourceRef, selectedNodeRef: initial.nodes[0].nodeRef };
  assert.equal((await owner.publish(input, publish(0), actor)).outcome, 'appended');
  const current = await owner.read(input);
  assert.equal(current.status, 'resolved');
  if (current.status !== 'resolved') return;
  assert.equal(current.nodes[0].summary, '新补的后续结果');
  assert.notEqual(refIdentity(initial.sourceRef), refIdentity(current.sourceRef));
  const old = await owner.read(selected);
  assert.equal(old.status, 'resolved');
  if (old.status !== 'resolved') return;
  assert.equal(old.nodes[0].summary, initial.nodes[0].summary);
  assert.equal(old.publication?.selectionUpdate?.kind, 'modified');
  assert.equal(evolutionExplorationReviewV1Schema.safeParse(old).success, true);
  const failed = await owner.publish(input, publish(1, c), actor);
  assert.equal('attempt' in failed && failed.attempt.status, 'failed');
  assert.equal((await owner.status(input)).current.revision, 1);
  const restore = await owner.publish(
    input,
    {
      action: 'restore',
      expectedRevision: 2,
      restoreRevision: 0,
      clientMessageId: 'restore',
      reason: '退回上一份完整稿',
    },
    actor,
  );
  assert.equal('attempt' in restore && restore.attempt.revision, 3);
  const rebuilt = new HarnessHistoryPublicationOwner({ store, source });
  const restored = await rebuilt.read(input);
  assert.equal(restored.status, 'resolved');
  if (restored.status !== 'resolved') return;
  assert.equal(restored.nodes[0].summary, initial.nodes[0].summary);
  assert.equal(restored.publication?.current.revision, 3);
  const replay = await rebuilt.publish(input, publish(0), actor);
  assert.equal(replay.outcome, 'duplicate');
  assert.equal('attempt' in replay && replay.attempt.revision, 1);
  assert.equal((await rebuilt.status(input)).current.revision, 3);
  assert.equal(
    (await rebuilt.publish(input, { ...publish(0), reason: 'changed' }, actor)).outcome,
    'idempotency_collision',
  );
  assert.equal((await rebuilt.publish(input, publish(0, a, 'stale'), actor)).outcome, 'conflict');
});

test('competing publications append once; source refs cannot cross Program scope; old unversioned preferences receive explicit recovery', async () => {
  const { owner } = fixture();
  const attempts = await Promise.all([
    owner.publish(input, publish(0), actor),
    owner.publish(input, publish(0, a, 'other'), actor),
  ]);
  assert.deepEqual(attempts.map((result) => result.outcome).sort(), ['appended', 'conflict']);
  const current = await owner.status(input);
  await assert.rejects(
    () =>
      owner.read({
        ...input,
        programRef: { ...input.programRef, ownerStateRef: `evolution-program:${'2'.repeat(32)}` },
        selectedSourceRef: current.current.ref,
      }),
    { code: 'history_source_not_published' },
  );
  await assert.rejects(
    () => owner.read({ ...input, selectedSourceRef: { ...current.current.ref, version: 'publication:99:' + b } }),
    { code: 'history_source_not_published' },
  );
  const recovered = await owner.read({
    ...input,
    selectedNodeRef: { ownerFeatureId: 'F314', ownerStateRef: 'harness-history:release:H01', version: 'old' },
  });
  assert.equal(recovered.status, 'invalid');
  assert.equal(evolutionExplorationReviewV1Schema.safeParse(recovered).success, true);
  assert.deepEqual('recoverySelection' in recovered && recovered.recoverySelection, {
    selectedSourceRef: current.current.ref,
  });
});

test('a case moved out of a removed step maps to its new exact step; a removed case retains only the old reading', async () => {
  for (const removal of [false, true]) {
    const { owner, next } = fixture();
    const initial = await owner.read(input);
    assert.equal(initial.status, 'resolved');
    if (initial.status !== 'resolved') return;
    const oldStep = next.story.nodes[0].id;
    const targetStep = next.story.nodes[1].id;
    const selectedCase = next.story.cases.find((entry: { nodeId: string }) => entry.nodeId === oldStep);
    assert.ok(selectedCase);
    const selectedExperiment = initial.experiments.find(
      (entry) => entry.experimentRef.ownerStateRef === `harness-history:case:${selectedCase.caseId}`,
    );
    assert.ok(selectedExperiment);
    const selection = {
      ...input,
      selectedSourceRef: initial.sourceRef,
      selectedNodeRef: selectedExperiment.nodeRef,
      selectedExperimentRef: selectedExperiment.experimentRef,
    };
    next.story.nodes = next.story.nodes.filter((entry: { id: string }) => entry.id !== oldStep);
    for (const node of next.story.nodes)
      node.parents = node.parents.filter((entry: { nodeId: string }) => entry.nodeId !== oldStep);
    for (const entry of next.story.cases) if (entry.nodeId === oldStep) entry.nodeId = targetStep;
    if (removal) {
      next.cases = next.cases.filter((entry: { caseId: string }) => entry.caseId !== selectedCase.caseId);
      next.story.cases = next.story.cases.filter((entry: { caseId: string }) => entry.caseId !== selectedCase.caseId);
    }
    const result = await owner.publish(input, publish(0), actor);
    assert.equal('attempt' in result && result.attempt.status, 'published');
    const old = await owner.read(selection);
    assert.equal(old.status, 'resolved');
    if (old.status !== 'resolved') return;
    const update = old.publication?.selectionUpdate;
    assert.equal(update?.kind, removal ? 'removed' : 'moved');
    assert.equal(old.details[0].status, 'resolved');
    if (removal) assert.equal(update?.nextSelection, undefined);
    else {
      assert.equal(update?.nextSelection?.selectedNodeRef?.ownerStateRef, `harness-history:story:${targetStep}`);
      const current = await owner.read({ ...input, ...update?.nextSelection });
      assert.equal(current.status, 'resolved');
      assert.equal(evolutionExplorationReviewV1Schema.safeParse(current).success, true);
    }
  }
});
