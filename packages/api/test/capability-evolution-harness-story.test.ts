import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { evolutionExplorationReviewV1Schema } from '@cat-cafe/shared';
import { projectRequestReviewHarnessExploration } from '../src/infrastructure/capability-evolution/adapters/request-review/request-review-harness-lineage.js';

const archive = JSON.parse(
  readFileSync(
    new URL('../../../docs/discussions/f314-incident-archive/lineage/lineage-index.json', import.meta.url),
    'utf8',
  ),
);
const input = {
  programRef: { ownerFeatureId: 'F311', ownerStateRef: 'program:history', version: '1' },
  objectRef: {
    ownerFeatureId: 'F100',
    ownerStateRef: 'capability:development-process-harness-effectiveness',
    version: '1',
  },
};
const readAt = '2026-10-16T10:30:00.000Z';
test('the published F314 index opens the latest cases with their actual later outcomes', () => {
  const catalog = projectRequestReviewHarnessExploration(input, archive, readAt);
  assert(catalog);
  assert.equal(evolutionExplorationReviewV1Schema.safeParse(catalog).success, true);
  assert.deepEqual(
    catalog.blockers.map((blocker) => blocker.code),
    ['public_archive_not_program_adoption'],
  );
  assert(catalog.nodes.some((node) => node.title.includes('10月16日：')));
  const saved = catalog.experiments.find((entry) => entry.experimentRef.ownerStateRef.includes('f322-save-readback'));
  assert(saved, 'the real member-save counterexample must be reachable from exploration');
  const detail = projectRequestReviewHarnessExploration(
    { ...input, selectedExperimentRef: saved.experimentRef },
    archive,
    readAt,
  );
  assert(detail);
  assert.equal(evolutionExplorationReviewV1Schema.safeParse(detail).success, true);
  const record = detail.details[0]?.status === 'resolved' ? detail.details[0].records[0] : undefined;
  assert(record);
  assert.match(record.output[0]?.value ?? '', /GET503/);
  assert.match(record.result.label, /Alpha/);
  assert.match(record.result.label, /正式加载/);
});

const fixture = () => ({
  ...archive,
  schemaVersion: 2,
  status: 'source-backed-evolution-story',
  cases: archive.cases.slice(0, 2).map((entry: object, index: number) => ({ ...entry, caseId: `case-${index}` })),
  story: {
    updated: '2026-10-16',
    sources: [
      {
        id: 'journey',
        label: '真实输入验收修订',
        path: 'docs/discussions/f314-incident-archive/cases/2026-10-07-f232-plan-only-shadow-replay.md',
      },
    ],
    nodes: [
      {
        id: 'complete-result',
        when: '9月19日',
        title: '先看整件事是否完成',
        summary: '局部通过后仍要对照原托付。',
        parents: [],
        changes: [{ label: '应对', detail: '把原始结果带进交付判断。', sourceId: 'journey' }],
      },
      {
        id: 'real-input',
        when: '10月7日',
        title: '用需求方的真实例子验收',
        summary: '能列出产物还不够，原话里的文件必须点得开。',
        parents: [
          { nodeId: 'complete-result', sourceId: 'journey', reason: '沿完整旅程要求，进一步固定真实输入与核心动作。' },
        ],
        changes: [{ label: '应对', detail: '打开需求方点名的 backlog。', sourceId: 'journey' }],
      },
    ],
    cases: [
      {
        caseId: 'case-0',
        nodeId: 'complete-result',
        problem: '局部批准被当成整项完成。',
        response: '恢复原始需求并区分批准范围。',
        outcome: '局部证据保留，完整交付继续。',
        sourceIds: ['journey'],
      },
      {
        caseId: 'case-1',
        nodeId: 'real-input',
        problem: '清单能列出 backlog，却打不开内容。',
        response: '改用需求方的真实文件，从打开走到读到正文。',
        outcome: '真实输入要求已落地；后续案例仍暴露执行遗漏。',
        sourceIds: ['journey'],
      },
    ],
  },
});

test('publishes declared problem-to-response lineage instead of unrelated calendar buckets', () => {
  const result = projectRequestReviewHarnessExploration(input, fixture(), readAt);
  assert(result, 'source-backed history must be available in the existing exploration surface');
  assert.equal(evolutionExplorationReviewV1Schema.safeParse(result).success, true);
  assert.deepEqual(
    result.nodes.map((node) => node.title),
    ['先看整件事是否完成', '用需求方的真实例子验收'],
  );
  assert.deepEqual(result.nodes[1]?.parentEdges[0]?.parentNodeRef, result.nodes[0]?.nodeRef);
  assert.equal(result.nodes[1]?.parentEdges[0]?.description, '沿完整旅程要求，进一步固定真实输入与核心动作。');
  assert.deepEqual(result.nodes[0]?.kind === 'public_archive' && result.nodes[0].history, {
    period: '9月19日',
    updatedThrough: '2026-10-16',
  });
  assert(result.nodes.every((node) => node.kind === 'public_archive'));
  assert.equal(result.details.length, 0);
});

test('selected case shows the problem, concrete response and later outcome with pinned sources', () => {
  const index = fixture();
  const catalog = projectRequestReviewHarnessExploration(input, index, readAt);
  assert(catalog);
  const selected = catalog.experiments[1];
  assert(selected);
  const result = projectRequestReviewHarnessExploration(
    { ...input, selectedExperimentRef: selected.experimentRef },
    index,
    readAt,
  );
  const record = result?.details[0]?.status === 'resolved' ? result.details[0].records[0] : undefined;
  assert(record);
  assert.deepEqual(
    record.output.map((entry) => entry.label),
    ['踩了什么坑', '当时怎么应对'],
  );
  assert.match(record.result.label, /后续案例仍暴露执行遗漏/);
  assert.equal(record.result.status, 'observed');
  assert(record.sources.some((source) => source.href?.includes(`/blob/${index.snapshotCommit}/docs/`)));
  assert.equal(result?.experiments[1]?.metrics.length, 0, 'historical outcomes must not invent efficacy scores');
});

test('rejects unsupported relationships and missing case narratives rather than filling chronology', () => {
  const missing = fixture();
  const missingParent = missing.story.nodes[1]?.parents[0];
  assert(missingParent);
  missingParent.sourceId = 'not-a-source';
  assert.equal(projectRequestReviewHarnessExploration(input, missing, readAt), null);
  const cyclic = fixture();
  const root = cyclic.story.nodes[0];
  assert(root);
  root.parents.push({ nodeId: 'real-input', sourceId: 'journey', reason: 'invalid cycle' });
  assert.equal(projectRequestReviewHarnessExploration(input, cyclic, readAt), null);
  const incomplete = fixture();
  incomplete.story.cases.pop();
  assert.equal(projectRequestReviewHarnessExploration(input, incomplete, readAt), null);
});
